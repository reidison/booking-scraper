const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

// Carregar variáveis de ambiente do .env
require('dotenv').config({ path: path.join(__dirname, '.env') });

puppeteer.use(StealthPlugin());

// ══════════════════════════════════════════════════════════════
//  CONFIGURAÇÃO
// ══════════════════════════════════════════════════════════════
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;               // anon key — leitura pública
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; // service role — escrita direta (opcional)
const BOT_API_KEY = process.env.BOT_API_KEY || 'booking-scraper-2026';
const INTERVALO_PADRAO_MS = 15 * 60 * 1000;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ ERRO: SUPABASE_URL e SUPABASE_KEY são obrigatórios no .env');
    process.exit(1);
}

// Anon key — leitura de propriedades aprovadas
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Service Role Key — grava direto nas tabelas sem RLS (preferencial)
// Se não estiver no .env, o robô usa a Edge Function como fallback.
const supabaseAdmin = SUPABASE_SERVICE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    : null;

const BOT_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/bot-update-prices`;

if (supabaseAdmin) {
    console.log('🔑 Modo: gravação direta no Supabase (SUPABASE_SERVICE_KEY presente)');
} else {
    console.log('⚡ Modo: Edge Function (SUPABASE_SERVICE_KEY não encontrada no .env)');
    console.log('   Para gravar direto, adicione SUPABASE_SERVICE_KEY ao .env');
}

// ══════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════

// Lê o intervalo configurado no painel Lovable (app_settings)
async function getIntervalMs() {
    try {
        const client = supabaseAdmin || supabase;
        const { data } = await client
            .from('app_settings')
            .select('value')
            .eq('key', 'scraper_interval_minutes')
            .single();
        const minutes = data?.value?.minutes;
        if (typeof minutes === 'number' && minutes >= 5 && minutes <= 120) {
            return minutes * 60 * 1000;
        }
    } catch (_) {}
    return INTERVALO_PADRAO_MS;
}

const formatDate = (date) => {
    const d = date.getDate().toString().padStart(2, '0');
    const m = (date.getMonth() + 1).toString().padStart(2, '0');
    const y = date.getFullYear();
    return `${y}-${m}-${d}`;
};

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ══════════════════════════════════════════════════════════════
//  BUSCAR PROPRIEDADES (leitura pública — sem autenticação)
// ══════════════════════════════════════════════════════════════
async function fetchProperties() {
    console.log('📡 Buscando propriedades do Supabase...');

    const { data: properties, error } = await supabase
        .from('properties')
        .select('id, name, price, source_url, category')
        .eq('status', 'approved');

    if (error) {
        console.error('❌ Erro ao buscar propriedades:', error.message);
        return [];
    }

    // Filtrar apenas propriedades com URLs válidas do Booking
    const valid = (properties || []).filter(p =>
        p.source_url && p.source_url.includes('booking.com')
    );

    console.log(`✅ ${valid.length} propriedades com link Booking encontradas.`);
    return valid;
}

// ══════════════════════════════════════════════════════════════
//  FALLBACK: ENVIAR VIA EDGE FUNCTION (quando não há SERVICE KEY)
// ══════════════════════════════════════════════════════════════
async function sendPricesToEdgeFunction(updates) {
    if (updates.length === 0) {
        console.log('ℹ️  Nenhuma atualização para enviar.');
        return;
    }
    console.log(`\n📡 Enviando ${updates.length} atualização(ões) via Edge Function...`);
    try {
        const response = await fetch(BOT_FUNCTION_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_KEY}`,
            },
            body: JSON.stringify({ bot_key: BOT_API_KEY, updates }),
        });
        const result = await response.json();
        if (result.success) {
            console.log(`✅ Edge Function: ${result.changes_count} alteração(ões) gravada(s).`);
            for (const r of (result.results || [])) {
                const icon = r.action === 'updated' ? '💰' : r.action === 'created' ? '🆕' : '✅';
                console.log(`   ${icon} ${r.property} / ${r.room}: R$ ${r.old_price} → R$ ${r.new_price} (${r.action})`);
            }
        } else {
            console.error(`❌ Erro da Edge Function: ${result.error}`);
        }
    } catch (err) {
        console.error(`❌ Erro ao chamar Edge Function: ${err.message}`);
    }
}

// Despachante: usa gravação direta se disponível, Edge Function caso contrário
async function saveUpdates(updates) {
    if (supabaseAdmin) {
        await updateSupabaseDirectly(updates);
    } else {
        await sendPricesToEdgeFunction(updates);
    }
}

// ══════════════════════════════════════════════════════════════
//  GRAVAR PREÇOS DIRETAMENTE NO SUPABASE (com SERVICE KEY)
// ══════════════════════════════════════════════════════════════

function normalize(s) {
    return s.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

async function updateSupabaseDirectly(updates) {
    if (updates.length === 0) {
        console.log('ℹ️  Nenhuma atualização para gravar.');
        return;
    }

    console.log(`\n💾 Gravando ${updates.length} entrada(s) diretamente no Supabase...`);

    // Carrega propriedades e quartos existentes
    const { data: properties, error: propErr } = await supabaseAdmin
        .from('properties').select('id, name, price, source_url');
    const { data: rooms, error: roomErr } = await supabaseAdmin
        .from('rooms').select('id, name, price, property_id, adults, children');

    if (propErr || roomErr) {
        console.error('❌ Erro ao carregar dados do Supabase:', propErr?.message || roomErr?.message);
        return;
    }

    // Índices para lookup rápido
    const propById = new Map();
    const propByName = new Map();
    for (const p of (properties || [])) {
        propById.set(p.id, p);
        propByName.set(normalize(p.name), p);
    }

    const roomsByProp = new Map();
    for (const r of (rooms || [])) {
        if (!roomsByProp.has(r.property_id)) roomsByProp.set(r.property_id, []);
        roomsByProp.get(r.property_id).push(r);
    }

    const now = new Date().toISOString();
    let changesCount = 0;
    const notFound = [];
    const historyInserts = [];

    // Agrupar atualizações recebidas por propriedade
    const updatesByProp = new Map();
    for (const update of updates) {
        const { property_id, property_name } = update;
        
        let prop = property_id ? propById.get(property_id) : undefined;
        if (!prop && property_name) {
            const key = normalize(property_name);
            prop = propByName.get(key);
            if (!prop) {
                for (const [k, v] of propByName) {
                    if (k.includes(key) || key.includes(k)) { prop = v; break; }
                }
            }
        }

        if (!prop) {
            console.log(`   ⚠️  Propriedade não encontrada no banco: ${property_name}`);
            if (property_name && !notFound.includes(property_name)) {
                notFound.push(property_name);
            }
            continue;
        }

        const propId = prop.id;
        if (!updatesByProp.has(propId)) {
            updatesByProp.set(propId, []);
        }
        updatesByProp.get(propId).push({ ...update, resolved_prop: prop });
    }

    // Processar atualizações de cada propriedade de forma atômica
    for (const [propId, propUpdates] of updatesByProp.entries()) {
        const prop = propUpdates[0].resolved_prop;
        const propRooms = roomsByProp.get(propId) || [];
        const latestSourceUrl = propUpdates[0].source_url || prop.source_url;

        // Checa se toda a propriedade foi marcada como esgotada no lote
        const isPropSoldOut = propUpdates.every(u => u.status === 'sold_out' || u.price <= 0);

        if (isPropSoldOut) {
            // Excluir todos os quartos existentes (esgotados) em lote
            if (propRooms.length > 0) {
                const roomIdsToDelete = propRooms.map(r => r.id);
                await supabaseAdmin.from('rooms').delete().in('id', roomIdsToDelete);
                for (const room of propRooms) {
                    historyInserts.push({
                        property_id: propId,
                        room_id: null,
                        room_name: room.name + " (Excluído - Esgotado)",
                        old_price: room.price,
                        new_price: 0,
                        source_url: latestSourceUrl,
                        checked_at: now,
                        verified_at: now,
                    });
                    changesCount++;
                    console.log(`   🗑️ ${prop.name} / ${room.name}: esgotado e excluído (era R$ ${room.price})`);
                }
            }
            
            // Zera preço base da propriedade e atualiza URL
            if (prop.price > 0 || prop.source_url !== latestSourceUrl) {
                await supabaseAdmin.from('properties').update({ price: 0, source_url: latestSourceUrl }).eq('id', propId);
                if (prop.price > 0) {
                    historyInserts.push({
                        property_id: propId,
                        room_id: null,
                        room_name: 'Indisponível (Esgotado)',
                        old_price: prop.price,
                        new_price: 0,
                        source_url: latestSourceUrl,
                        checked_at: now,
                        verified_at: now,
                    });
                    changesCount++;
                }
                console.log(`   🚫 ${prop.name}: esgotado (era R$ ${prop.price})`);
            }
            continue;
        }

        // Processa quartos ativos
        const updatedRoomIds = new Set();
        const activeRoomPrices = [];

        for (const update of propUpdates) {
            const { room_name, price, adults, children, source_url } = update;
            if (price <= 0 || update.status === 'sold_out') continue;

            const normalizedRoom = normalize(room_name || 'geral');
            let matchedRoom;

            // 1) Match exato de nome normalizado e capacidade
            for (const r of propRooms) {
                if (normalize(r.name) === normalizedRoom && 
                    (r.adults === undefined || r.adults === adults) && 
                    (r.children === undefined || r.children === children)) {
                    matchedRoom = r;
                    break;
                }
            }
            // 2) Match parcial se não houver exato
            if (!matchedRoom) {
                for (const r of propRooms) {
                    const normR = normalize(r.name);
                    if ((normR.includes(normalizedRoom) || normalizedRoom.includes(normR)) &&
                        (r.adults === undefined || r.adults === adults) && 
                        (r.children === undefined || r.children === children)) {
                        matchedRoom = r;
                        break;
                    }
                }
            }

            if (matchedRoom) {
                updatedRoomIds.add(matchedRoom.id);
                activeRoomPrices.push(price);

                const updateData = { price };
                if (adults !== undefined) updateData.adults = adults;
                if (children !== undefined) updateData.children = children;

                if (matchedRoom.price !== price || matchedRoom.adults !== adults || matchedRoom.children !== children) {
                    await supabaseAdmin.from('rooms').update(updateData).eq('id', matchedRoom.id);
                    historyInserts.push({
                        property_id: propId,
                        room_id: matchedRoom.id,
                        room_name: matchedRoom.name,
                        old_price: matchedRoom.price,
                        new_price: price,
                        source_url: source_url || null,
                        checked_at: now,
                        verified_at: now,
                    });
                    changesCount++;
                    console.log(`   💰 ${prop.name} / ${matchedRoom.name}: R$ ${matchedRoom.price} → R$ ${price}`);
                } else {
                    console.log(`   ✅ ${prop.name} / ${matchedRoom.name}: sem alteração (R$ ${price})`);
                }
            } else {
                // Criar novo quarto
                const { data: newRoom } = await supabaseAdmin.from('rooms').insert({
                    property_id: propId,
                    name: room_name || 'Quarto Padrão',
                    price,
                    adults: adults ?? 2,
                    children: children ?? 0,
                    available: 1
                }).select('id').single();

                if (newRoom) {
                    updatedRoomIds.add(newRoom.id);
                    activeRoomPrices.push(price);

                    historyInserts.push({
                        property_id: propId,
                        room_id: newRoom.id,
                        room_name: room_name || 'Quarto Padrão',
                        old_price: 0,
                        new_price: price,
                        source_url: source_url || null,
                        checked_at: now,
                        verified_at: now,
                    });
                    changesCount++;
                    console.log(`   🆕 ${prop.name} / ${room_name}: novo quarto criado (R$ ${price})`);
                }
            }
        }

        // Excluir quartos que NÃO vieram na raspagem (quartos obsoletos/desatualizados) em lote
        const obsoleteRooms = propRooms.filter(room => !updatedRoomIds.has(room.id));
        if (obsoleteRooms.length > 0) {
            const obsoleteIds = obsoleteRooms.map(r => r.id);
            await supabaseAdmin.from('rooms').delete().in('id', obsoleteIds);
            for (const room of obsoleteRooms) {
                historyInserts.push({
                    property_id: propId,
                    room_id: null,
                    room_name: room.name + ' (Excluído)',
                    old_price: room.price,
                    new_price: 0,
                    source_url: latestSourceUrl,
                    checked_at: now,
                    verified_at: now,
                });
                changesCount++;
                console.log(`   🗑️ ${prop.name} / ${room.name}: excluído/não listado nesta rodada (era R$ ${room.price})`);
            }
        }

        // Atualiza preço base da propriedade com o menor preço ativo da rodada e atualiza URL
        const minPrice = activeRoomPrices.length > 0 ? Math.min(...activeRoomPrices) : 0;
        if (prop.price !== minPrice || prop.source_url !== latestSourceUrl) {
            await supabaseAdmin.from('properties').update({ price: minPrice, source_url: latestSourceUrl }).eq('id', propId);
            if (prop.price !== minPrice) {
                historyInserts.push({
                    property_id: propId,
                    room_id: null,
                    room_name: minPrice > 0 ? 'Preço Base Atualizado' : 'Indisponível (Esgotado)',
                    old_price: prop.price,
                    new_price: minPrice,
                    source_url: latestSourceUrl,
                    checked_at: now,
                    verified_at: now,
                });
                changesCount++;
            }
            console.log(`   🏨 ${prop.name}: preço base/URL atualizado(s) no Supabase (menor preço: R$ ${minPrice})`);
        }
    }

    // Gravação dos históricos acumulados em um único comando insert em lote
    if (historyInserts.length > 0) {
        const { error } = await supabaseAdmin.from('price_history').insert(historyInserts);
        if (error) {
            console.error('❌ Erro ao gravar histórico de preços em lote:', error.message);
        }
    }

    console.log(`\n✅ ${changesCount} alteração(ões) gravada(s) diretamente no Supabase.`);
}

// ══════════════════════════════════════════════════════════════
//  SCRAPING PRINCIPAL
// ══════════════════════════════════════════════════════════════
async function run() {
    const today = new Date();
    // Usar hoje como check-in para buscar preços do mesmo dia (realtime/last minute)
    const checkin = new Date(today);
    
    const checkout = new Date(checkin);
    checkout.setDate(checkout.getDate() + 1);
    
    const checkinDate = formatDate(checkin);
    const checkoutDate = formatDate(checkout);

    console.log('\n══════════════════════════════════════════════════════════');
    console.log('   🤖 ROBÔ BOOKING-SCRAPER → LOVABLE (via Edge Function)');
    console.log(`   📅 Check-in: ${checkinDate} | Check-out: ${checkoutDate}`);
    console.log(`   ⏰ ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);
    console.log('══════════════════════════════════════════════════════════\n');

    // 1) Buscar propriedades (leitura pública)
    const properties = await fetchProperties();

    if (properties.length === 0) {
        console.log('⚠️  Nenhuma propriedade com link Booking encontrada.');
        return;
    }

    // 2) Iniciar navegador
    console.log('🌐 Iniciando navegador Puppeteer (modo stealth)...');
    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process',
        ],
    });

    const allUpdates = [];

    for (let i = 0; i < properties.length; i++) {
        const prop = properties[i];
        console.log(`\n[${i + 1}/${properties.length}] 🏨 ${prop.name}`);

        // Construir URL com datas dinâmicas ou preservadas
        let urlToScrape;
        try {
            urlToScrape = new URL(prop.source_url.trim());
            
            // Extrair parâmetros funcionais originais antes de limpar a query string
            const originalCheckin = urlToScrape.searchParams.get('checkin');
            const originalCheckout = urlToScrape.searchParams.get('checkout');
            const originalAdults = urlToScrape.searchParams.get('group_adults') || urlToScrape.searchParams.get('req_adults');
            const originalChildren = urlToScrape.searchParams.get('group_children') || urlToScrape.searchParams.get('req_children');
            const originalNoRooms = urlToScrape.searchParams.get('no_rooms');
            const originalRoom1 = urlToScrape.searchParams.get('room1');
            
            // Limpar parâmetros antigos (como aid, label) para evitar redirecionamento forçado para a busca
            urlToScrape.search = '';
            
            // Garantir locale pt-br — cobre .pt-pt.html, .en-us.html, .html sem locale e sem .html
            const p = urlToScrape.pathname;
            if (/\.[a-z]{2}(?:-[a-z]{2})?\.html$/i.test(p)) {
                urlToScrape.pathname = p.replace(/\.[a-z]{2}(?:-[a-z]{2})?\.html$/i, '.pt-br.html');
            } else if (p.endsWith('.html')) {
                urlToScrape.pathname = p.replace(/\.html$/i, '.pt-br.html');
            } else {
                urlToScrape.pathname = p.replace(/\/$/, '') + '.pt-br.html';
            }
            urlToScrape.searchParams.set('lang', 'pt-br');
            
            // Definir checkin e checkout (prioridade para o original se for data futura)
            let useOriginal = false;
            if (originalCheckin && originalCheckout) {
                try {
                    const originalCheckinDate = new Date(originalCheckin + 'T00:00:00');
                    const todayMidnight = new Date();
                    todayMidnight.setHours(0, 0, 0, 0);
                    if (originalCheckinDate >= todayMidnight) {
                        useOriginal = true;
                    } else {
                        console.log(`   ⚠️  Datas do link original estão no passado (${originalCheckin}). Usando datas dinâmicas.`);
                    }
                } catch (_) {
                    useOriginal = false;
                }
            }

            if (useOriginal && originalCheckin && originalCheckout) {
                urlToScrape.searchParams.set('checkin', originalCheckin);
                urlToScrape.searchParams.set('checkout', originalCheckout);
            } else {
                urlToScrape.searchParams.set('checkin', checkinDate);
                urlToScrape.searchParams.set('checkout', checkoutDate);
            }
            
            // Definir quantidade de hóspedes e quartos (prioridade para o original)
            urlToScrape.searchParams.set('group_adults', originalAdults || '2');
            urlToScrape.searchParams.set('group_children', originalChildren || '0');
            urlToScrape.searchParams.set('no_rooms', originalNoRooms || '1');
            if (originalRoom1) {
                urlToScrape.searchParams.set('room1', originalRoom1);
            }
        } catch (e) {
            console.log(`   ❌ URL inválida: ${prop.source_url}`);
            continue;
        }

        console.log(`   📅 Pesquisando período: ${urlToScrape.searchParams.get('checkin')} a ${urlToScrape.searchParams.get('checkout')} (${urlToScrape.searchParams.get('group_adults')} adulto(s), ${urlToScrape.searchParams.get('group_children')} criança(s))`);

        const page = await browser.newPage();

        // User-Agent rotativo
        const userAgents = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        ];
        await page.setUserAgent(userAgents[i % userAgents.length]);

        await page.setExtraHTTPHeaders({
            'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        });

        let currentUrl = prop.source_url.trim();
        try {
            await page.goto(urlToScrape.toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });
            currentUrl = page.url() || urlToScrape.toString();

            // Aceitar cookie consent (GDPR) — bloqueia a tabela de disponibilidade se não for dispensado
            const cookieSelectors = [
                '#onetrust-accept-btn-handler',
                '[id*="accept"][id*="cookie"]',
                'button[data-gdpr-consent="accept"]',
                '.bui-button--primary[data-testid="accept-cookies-button"]',
            ];
            for (const sel of cookieSelectors) {
                try {
                    await page.click(sel, { timeout: 3000 });
                    await sleep(800);
                    break;
                } catch (_) {}
            }

            // Espera variável (5-8s) para evitar detecção de padrão
            const waitTime = 5000 + Math.floor(Math.random() * 3000);
            await sleep(waitTime);

            // Aguarda a tabela de disponibilidade carregar (JS assíncrono)
            try {
                await page.waitForSelector(
                    '.hprt-table, [data-testid="availability-table"], table[data-block="availability_table"]',
                    { timeout: 15000 }
                );
            } catch (_) {
                console.log('   ⚠️  Tabela de disponibilidade não carregou — tentando extrair assim mesmo');
            }

            // Scroll humano
            await page.evaluate(() => window.scrollBy(0, 300));
            await sleep(1000);

            console.log('   🔍 Extraindo dados de preço...');
            const data = await page.evaluate(() => {

                // Função de parser de preço robusta rodando dentro do navegador para páginas em Pt-Br (BRL)
                const parsePriceText = (text) => {
                    if (!text) return null;
                    const cleanText = text.trim();
                    if (!cleanText.includes('R$')) return null;
                    
                    // Limpa mantendo apenas dígitos, ponto e vírgula
                    const filtered = cleanText.replace(/[^0-9.,]/g, '');
                    if (!filtered) return null;
                    
                    let priceVal = null;
                    const hasDot = filtered.includes('.');
                    const hasComma = filtered.includes(',');
                    
                    if (hasDot && hasComma) {
                        // Exemplo: 1.250,50 -> 1250.50
                        priceVal = parseFloat(filtered.replace(/\./g, '').replace(/,/g, '.'));
                    } else if (hasComma) {
                        // Exemplo: 589,00 -> 589.00
                        priceVal = parseFloat(filtered.replace(/,/g, '.'));
                    } else if (hasDot) {
                        // Exemplo: 1.250 -> 1250
                        const parts = filtered.split('.');
                        if (parts[parts.length - 1].length === 3) {
                            priceVal = parseFloat(filtered.replace(/\./g, ''));
                        } else {
                            priceVal = parseFloat(filtered);
                        }
                    } else {
                        priceVal = parseFloat(filtered);
                    }
                    
                    if (isNaN(priceVal) || priceVal <= 0) return null;
                    
                    return Math.round(priceVal * 100) / 100;
                };

                // Extrai todos os tipos de quarto com seus preços da tabela de disponibilidade.
                // A extração é feita ANTES de qualquer checagem de isSoldOut:
                // se encontrou preços reais na tabela, a propriedade NÃO está esgotada,
                // independente de textos como "Datas alternativas" ou "Sold out" que podem
                // aparecer em seções de sugestão da mesma página.
                const extractAllRooms = () => {
                    const table = document.querySelector('.hprt-table') ||
                                  document.querySelector('[data-testid="availability-table"]') ||
                                  document.querySelector('table[data-block="availability_table"]');
                    if (!table) return [];

                    const roomMap = new Map(); // key -> { name, price, adults, children }
                    let currentRoomName = null;

                    const priceSelectors = [
                        '.bui-price-display__value',
                        '.prc-box-format__value',
                        '[data-testid="price-and-discounted-price"]',
                        '.prco-valign-middle-helper',
                        'span.prco-inline-block-maker-helper',
                        '[data-testid="price-display-value"]',
                        '.prco-text-nowrap-helper'
                    ];

                    const rows = table.querySelectorAll('tr');
                    for (const row of rows) {
                        // 1. Detect room name/category in this row (or inherited from rowspan)
                        const roomNameEl = row.querySelector(
                            'a[data-testid="rt-name-link"], .hprt-roomtype-link, [data-testid="room-type-name"], [data-testid="roomtype-name"], .hprt-roomtype-icon-link, .room-name, span.rt-room-title, [data-cell-id*="room_type"] a, a[href*="#rd-"]'
                        );
                        if (roomNameEl) {
                            const txt = roomNameEl.innerText.trim();
                            if (txt) currentRoomName = txt;
                        }

                        if (!currentRoomName) continue;

                        // 2. Extract occupancy (capacity) for adults and children
                        let adults = 2; // default fallback
                        let children = 0; // default fallback

                        // Search for occupancy column/container in row
                        const occupancyEl = row.querySelector(
                            '.hprt-occupancy, [data-testid="occupancy-column"], [data-testid="occupancy-icon-group"], .bui-icon--occupancy, .occupancy-container, [class*="occupancy"], [class*="capacity"], [class*="people"]'
                        );

                        if (occupancyEl) {
                            // Try from attributes
                            const dataOcc = occupancyEl.getAttribute('data-occupancy') || 
                                             occupancyEl.getAttribute('data-capacity') ||
                                             occupancyEl.getAttribute('data-max-occupancy');
                            if (dataOcc && !isNaN(parseInt(dataOcc))) {
                                adults = parseInt(dataOcc);
                            } else {
                                // Try screen reader text
                                const srEl = occupancyEl.querySelector('.sr-only, .visually-hidden');
                                const textToSearch = (srEl ? srEl.innerText : occupancyEl.innerText || occupancyEl.getAttribute('title') || '').toLowerCase();
                                
                                const adultMatch = textToSearch.match(/(\d+)\s*(?:adulto|pessoa|guest|hospede|adult|pax)/i);
                                const childMatch = textToSearch.match(/(\d+)\s*(?:crianca|child|menor)/i);
                                
                                if (adultMatch) adults = parseInt(adultMatch[1]);
                                if (childMatch) children = parseInt(childMatch[1]);

                                if (!adultMatch) {
                                    // Count icons
                                    const icons = occupancyEl.querySelectorAll('.bui-icon--occupancy, i[class*="user"], svg[class*="user"], .occupancy-icon');
                                    if (icons.length > 0) {
                                        adults = icons.length;
                                    }
                                }
                            }
                        } else {
                            // Fallback row text search
                            const textToSearch = row.innerText.toLowerCase();
                            const adultMatch = textToSearch.match(/(\d+)\s*(?:adulto|pessoa|guest|hospede|adult|pax)/i);
                            const childMatch = textToSearch.match(/(\d+)\s*(?:crianca|child|menor)/i);
                            if (adultMatch) adults = parseInt(adultMatch[1]);
                            if (childMatch) children = parseInt(childMatch[1]);
                        }

                        // 3. Extract price for this row
                        let rowPrice = null;
                        let foundPrice = false;
                        for (const sel of priceSelectors) {
                            if (foundPrice) break;
                            const els = row.querySelectorAll(sel);
                            for (const el of els) {
                                // Check if inside strike-through elements
                                let parent = el.parentElement;
                                let inStrikethrough = false;
                                while (parent && parent !== row) {
                                    if (parent.tagName === 'DEL' || parent.tagName === 'S') {
                                        inStrikethrough = true;
                                        break;
                                    }
                                    parent = parent.parentElement;
                                }
                                if (inStrikethrough) continue;

                                const txt = el.innerText.trim();
                                const price = parsePriceText(txt);
                                if (price === null || isNaN(price) || price < 20) continue;

                                // Encontra o container da célula de preço para buscar possíveis taxas
                                let cell = el;
                                while (cell && cell.parentElement) {
                                    const className = (cell.className || '').toString().toLowerCase();
                                    if (cell.tagName === 'TD' || className.includes('price') || className.includes('cell') || cell.tagName === 'TR') {
                                        break;
                                    }
                                    cell = cell.parentElement;
                                }
                                const cellText = cell ? cell.innerText || '' : '';

                                // Procura por taxas adicionais como "+ R$ 20 de impostos e taxas"
                                const taxMatch = cellText.match(/\+\s*(?:R\$|\$)\s*([\d.,]+)/i);
                                if (taxMatch) {
                                    const taxStr = taxMatch[1];
                                    const taxPrice = parsePriceText("R$ " + taxStr);
                                    if (taxPrice !== null && !isNaN(taxPrice)) {
                                        rowPrice = price + taxPrice;
                                    } else {
                                        rowPrice = price;
                                    }
                                } else {
                                    rowPrice = price;
                                }

                                foundPrice = true;
                                break;
                            }
                        }

                        if (rowPrice !== null) {
                            const optionKey = `${currentRoomName}_${adults}_${children}`;
                            if (!roomMap.has(optionKey) || rowPrice < roomMap.get(optionKey).price) {
                                roomMap.set(optionKey, {
                                    name: currentRoomName,
                                    price: rowPrice,
                                    adults: adults,
                                    children: children
                                });
                            }
                        }
                    }

                    return Array.from(roomMap.values()).sort((a, b) => a.price - b.price);
                };

                const rooms = extractAllRooms();

                // Extração do menor preço da tabela (fallback)
                let lowestTablePrice = null;
                const table = document.querySelector('.hprt-table') ||
                              document.querySelector('[data-testid="availability-table"]') ||
                              document.querySelector('table[data-block="availability_table"]');
                if (table) {
                    const priceEls = table.querySelectorAll('.bui-price-display__value, .prc-box-format__value, [data-testid="price-and-discounted-price"], .prco-valign-middle-helper, span.prco-inline-block-maker-helper, [data-testid="price-display-value"], .prco-text-nowrap-helper');
                    for (const el of priceEls) {
                        let parent = el.parentElement;
                        let inStrikethrough = false;
                        while (parent && parent !== table) {
                            if (parent.tagName === 'DEL' || parent.tagName === 'S') {
                                inStrikethrough = true;
                                break;
                            }
                            parent = parent.parentElement;
                        }
                        if (inStrikethrough) continue;

                        const price = parsePriceText(el.innerText);
                        if (price !== null && !isNaN(price) && price >= 20) {
                            let finalPrice = price;
                            let cell = el;
                            while (cell && cell.parentElement && cell !== table) {
                                const className = (cell.className || '').toString().toLowerCase();
                                if (cell.tagName === 'TD' || className.includes('price') || className.includes('cell') || cell.tagName === 'TR') {
                                    break;
                                }
                                cell = cell.parentElement;
                            }
                            const cellText = cell ? cell.innerText || '' : '';
                            const taxMatch = cellText.match(/\+\s*(?:R\$|\$)\s*([\d.,]+)/i);
                            if (taxMatch) {
                                const taxStr = taxMatch[1];
                                const taxPrice = parsePriceText("R$ " + taxStr);
                                if (taxPrice !== null && !isNaN(taxPrice)) {
                                    finalPrice = price + taxPrice;
                                }
                            }

                            if (lowestTablePrice === null || finalPrice < lowestTablePrice) {
                                lowestTablePrice = finalPrice;
                            }
                        }
                    }
                }

                // Se encontrou quartos com preço → definitivamente disponível.
                if (rooms.length > 0) {
                    return { rooms, lowestTablePrice, isSoldOut: false };
                }

                // Nenhum quarto extraído → verificar se é realmente esgotado
                const bodyText = document.body.innerText;
                const hasTable = !!table;
                const isSoldOut = !hasTable ||
                    bodyText.includes('Esta acomodação não tem disponibilidade') ||
                    bodyText.includes('Este alojamento não tem disponibilidade') ||
                    bodyText.includes('Não temos disponibilidade para estas datas') ||
                    bodyText.includes('Não há disponibilidade para as datas') ||
                    bodyText.includes('Não há disponibilidade para os dias') ||
                    bodyText.includes('Sem disponibilidade para as datas') ||
                    bodyText.includes('No availability for your dates') ||
                    bodyText.includes('unavailable for your dates');

                return { rooms: [], lowestTablePrice, isSoldOut };
            });

            const { rooms, lowestTablePrice, isSoldOut } = data;

            if (rooms.length === 0 && lowestTablePrice > 0) {
                console.log(`   📋 Nenhum quarto estruturado, mas detectado menor preço da tabela: R$ ${lowestTablePrice}`);
                allUpdates.push({
                    property_id: prop.id,
                    property_name: prop.name,
                    room_name: 'Preço Base (Tabela)',
                    price: lowestTablePrice,
                    adults: 2,
                    children: 0,
                    source_url: currentUrl,
                    status: 'available',
                });
            } else if (isSoldOut || rooms.length === 0) {
                console.log(`   🚫 Indisponível ou sem quartos na tabela de disponibilidade`);
                allUpdates.push({
                    property_id: prop.id,
                    property_name: prop.name,
                    room_name: 'Indisponível (Esgotado)',
                    price: 0,
                    source_url: currentUrl,
                    status: 'sold_out',
                });
            } else {
                console.log(`   📋 ${rooms.length} tipo(s) de quarto encontrado(s):`);
                for (const room of rooms) {
                    console.log(`      💵 ${room.name} (${room.adults} adultos, ${room.children} crianças): R$ ${room.price.toFixed(2)}`);
                    allUpdates.push({
                        property_id: prop.id,
                        property_name: prop.name,
                        room_name: room.name,
                        price: room.price,
                        adults: room.adults,
                        children: room.children,
                        source_url: currentUrl,
                        status: 'available',
                    });
                }
            }

        } catch (error) {
            console.error(`   ❌ Erro ao processar ${prop.name}: ${error.message}`);
        }

        await page.close();

        // Pausa entre propriedades (3-6 segundos)
        if (i < properties.length - 1) {
            const pause = 3000 + Math.floor(Math.random() * 3000);
            console.log(`   ⏳ Aguardando ${Math.round(pause / 1000)}s...`);
            await sleep(pause);
        }
    }

    await browser.close();

    // Saneamento e validação estrita de segurança para o campo "price"
    const validUpdates = allUpdates.filter(update => {
        // Regra 7: Não envie price negativo, null, NaN ou string.
        if (update.price === null || update.price === undefined || isNaN(update.price)) {
            console.warn(`⚠️  Removendo atualização com preço inválido (null/NaN):`, update.property_name);
            return false;
        }
        if (typeof update.price !== 'number') {
            console.warn(`⚠️  Removendo atualização com preço não-numérico:`, update.property_name);
            return false;
        }
        if (update.price < 0) {
            console.warn(`⚠️  Removendo atualização com preço negativo:`, update.property_name);
            return false;
        }
        
        // Regra 6: Se o quarto estiver esgotado/indisponível: envie price: 0 e status: "sold_out".
        if (update.status === 'sold_out') {
            update.price = 0;
        }
        
        // Regra 5: Máximo 2 casas decimais. Arredonde valores fracionados.
        update.price = Math.round(update.price * 100) / 100;
        
        return true;
    });

    // 3) Gravar preços (direto ou via Edge Function conforme .env)
    await saveUpdates(validUpdates);

    console.log('\n══════════════════════════════════════════════════════════');
    console.log(`   ✅ Scraping finalizado!`);
    console.log(`   📊 ${properties.length} propriedades processadas, ${allUpdates.length} entradas de quarto enviadas`);
    console.log(`   ⏰ ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);
    console.log('══════════════════════════════════════════════════════════\n');
}

// ══════════════════════════════════════════════════════════════
//  LOOP DE EXECUÇÃO (intervalo configurável via painel Lovable)
// ══════════════════════════════════════════════════════════════
async function startLoop() {
    console.log('🚀 Robô Booking-Scraper → Lovable iniciado!\n');

    while (true) {
        await run().catch(err => console.error('❌ Erro:', err.message));

        const intervalMs = await getIntervalMs();
        const intervalMin = Math.round(intervalMs / 60000);
        console.log(`\n⏳ Próxima rodada em ${intervalMin} min.`);
        console.log(`   (Para alterar: Lovable → /dashboard/precos → Configurações do Robô)\n`);
        await sleep(intervalMs);
        console.log(`\n🔄 Nova rodada de scraping...`);
    }
}

// --once para teste, sem flag para loop contínuo
if (process.argv.includes('--once')) {
    run().catch(console.error);
} else {
    startLoop();
}
