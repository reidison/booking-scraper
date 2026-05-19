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
        const { data } = await supabase
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
        .from('rooms').select('id, name, price, property_id');

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
    const propBatchPrices = new Map(); // property_id → menor preço do lote

    for (const update of updates) {
        const { property_id, property_name, room_name, price, source_url, status } = update;

        // Lookup da propriedade
        let prop = property_id ? propById.get(property_id) : undefined;
        if (!prop) {
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
            continue;
        }

        // Esgotado
        if (status === 'sold_out' || price <= 0) {
            if (prop.price > 0) {
                await supabaseAdmin.from('price_history').insert({
                    property_id: prop.id, room_id: null,
                    room_name: 'Indisponível (Esgotado)',
                    old_price: prop.price, new_price: 0,
                    source_url: source_url || null, checked_at: now,
                });
                changesCount++;
                console.log(`   🚫 ${prop.name}: esgotado (era R$ ${prop.price})`);
            }
            propBatchPrices.set(prop.id, 0);
            continue;
        }

        // Rastreia menor preço do lote para esta propriedade
        const batch = propBatchPrices.get(prop.id);
        if (batch === undefined || (batch > 0 && price < batch)) {
            propBatchPrices.set(prop.id, price);
        }

        // Encontrar quarto pelo nome
        const propRooms = roomsByProp.get(prop.id) || [];
        const normRoom = normalize(room_name || 'geral');
        let matchedRoom = propRooms.find(r => {
            const n = normalize(r.name);
            return n === normRoom || n.includes(normRoom) || normRoom.includes(n);
        });

        if (matchedRoom) {
            if (matchedRoom.price !== price) {
                await supabaseAdmin.from('rooms').update({ price }).eq('id', matchedRoom.id);
                await supabaseAdmin.from('price_history').insert({
                    property_id: prop.id, room_id: matchedRoom.id,
                    room_name: matchedRoom.name,
                    old_price: matchedRoom.price, new_price: price,
                    source_url: source_url || null, checked_at: now,
                });
                changesCount++;
                console.log(`   💰 ${prop.name} / ${matchedRoom.name}: R$ ${matchedRoom.price} → R$ ${price}`);
            } else {
                console.log(`   ✅ ${prop.name} / ${matchedRoom.name}: sem alteração (R$ ${price})`);
            }
        } else {
            // Criar novo quarto
            const { data: newRoom } = await supabaseAdmin.from('rooms').insert({
                property_id: prop.id,
                name: room_name || 'Quarto Padrão',
                price,
            }).select('id').single();

            if (newRoom) {
                await supabaseAdmin.from('price_history').insert({
                    property_id: prop.id, room_id: newRoom.id,
                    room_name: room_name || 'Quarto Padrão',
                    old_price: prop.price, new_price: price,
                    source_url: source_url || null, checked_at: now,
                });
                changesCount++;
                console.log(`   🆕 ${prop.name} / ${room_name}: novo quarto criado (R$ ${price})`);
            }
        }
    }

    // Atualiza properties.price com o menor preço do lote por propriedade
    for (const [propId, minPrice] of propBatchPrices) {
        await supabaseAdmin.from('properties').update({ price: minPrice }).eq('id', propId);
    }

    console.log(`\n✅ ${changesCount} alteração(ões) gravada(s) diretamente no Supabase.`);
}

// ══════════════════════════════════════════════════════════════
//  SCRAPING PRINCIPAL
// ══════════════════════════════════════════════════════════════
async function run() {
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const checkinDate = formatDate(today);
    const checkoutDate = formatDate(tomorrow);

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

        // Construir URL com datas dinâmicas
        let urlToScrape;
        try {
            urlToScrape = new URL(prop.source_url.trim());
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
            urlToScrape.searchParams.set('checkin', checkinDate);
            urlToScrape.searchParams.set('checkout', checkoutDate);
            urlToScrape.searchParams.set('group_adults', '2');
            urlToScrape.searchParams.set('group_children', '0');
        } catch (e) {
            console.log(`   ❌ URL inválida: ${prop.source_url}`);
            continue;
        }

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

        try {
            await page.goto(urlToScrape.toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });

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

                    const roomPrices = new Map(); // nome do quarto -> menor preço
                    let currentRoomName = null;

                    const priceSelectors = [
                        '.bui-price-display__value',
                        '.prc-box-format__value',
                        '[data-testid="price-and-discounted-price"]',
                        '.prco-valign-middle-helper',
                        'span.prco-inline-block-maker-helper',
                    ];

                    const rows = table.querySelectorAll('tr');
                    for (const row of rows) {
                        // Detecta nome do quarto nesta linha (pode ter rowspan)
                        const roomNameEl = row.querySelector(
                            '.hprt-roomtype-link, [data-testid="room-type-name"], ' +
                            '[data-testid="roomtype-name"], .hprt-roomtype-icon-link, .room-name'
                        );
                        if (roomNameEl) {
                            const txt = roomNameEl.innerText.trim();
                            if (txt) currentRoomName = txt;
                        }

                        if (!currentRoomName) continue;

                        // Extrai preço desta linha ignorando tachados (<del>/<s>)
                        let foundPrice = false;
                        for (const sel of priceSelectors) {
                            if (foundPrice) break;
                            const els = row.querySelectorAll(sel);
                            for (const el of els) {
                                // Verifica se o elemento está dentro de um elemento tachado
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
                                if (!txt.includes('R$')) continue;

                                const cleanStr = txt.replace(/R\$\s?/g, '').replace(/\./g, '').replace(/,/g, '.').trim();
                                const match = cleanStr.match(/\d+(?:\.\d+)?/);
                                if (!match) continue;

                                const price = parseFloat(match[0]);
                                if (isNaN(price) || price < 20) continue;

                                // Mantém o menor preço por tipo de quarto
                                if (!roomPrices.has(currentRoomName) || price < roomPrices.get(currentRoomName)) {
                                    roomPrices.set(currentRoomName, price);
                                }
                                foundPrice = true;
                                break;
                            }
                        }
                    }

                    // Retorna ordenado do menor para o maior preço
                    return Array.from(roomPrices.entries())
                        .map(([name, price]) => ({ name, price }))
                        .sort((a, b) => a.price - b.price);
                };

                const rooms = extractAllRooms();

                // Se encontrou quartos com preço → definitivamente disponível.
                // Não consultar bodyText: frases como "Datas alternativas" ou "Sold out"
                // podem aparecer em seções de sugestão mesmo quando a tabela tem vagas.
                if (rooms.length > 0) {
                    return { rooms, isSoldOut: false };
                }

                // Nenhum quarto extraído → verificar se é realmente esgotado
                // usando apenas frases inequívocas de indisponibilidade total.
                const bodyText = document.body.innerText;
                const hasTable = !!(
                    document.querySelector('.hprt-table') ||
                    document.querySelector('[data-testid="availability-table"]') ||
                    document.querySelector('table[data-block="availability_table"]')
                );
                const isSoldOut = !hasTable ||
                    bodyText.includes('Esta acomodação não tem disponibilidade') ||
                    bodyText.includes('Este alojamento não tem disponibilidade') ||
                    bodyText.includes('Não temos disponibilidade para estas datas') ||
                    bodyText.includes('Não há disponibilidade para as datas') ||
                    bodyText.includes('Não há disponibilidade para os dias') ||
                    bodyText.includes('Sem disponibilidade para as datas') ||
                    bodyText.includes('No availability for your dates') ||
                    bodyText.includes('unavailable for your dates');

                return { rooms: [], isSoldOut };
            });

            const { rooms, isSoldOut } = data;

            if (isSoldOut || rooms.length === 0) {
                console.log(`   🚫 Indisponível ou sem quartos na tabela de disponibilidade`);
                allUpdates.push({
                    property_id: prop.id,
                    property_name: prop.name,
                    room_name: 'Indisponível (Esgotado)',
                    price: 0,
                    source_url: prop.source_url.trim(),
                    status: 'sold_out',
                });
            } else {
                console.log(`   📋 ${rooms.length} tipo(s) de quarto encontrado(s):`);
                for (const room of rooms) {
                    console.log(`      💵 ${room.name}: R$ ${room.price.toFixed(2)}`);
                    allUpdates.push({
                        property_id: prop.id,
                        property_name: prop.name,
                        room_name: room.name,
                        price: room.price,
                        source_url: prop.source_url.trim(),
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

    // 3) Gravar preços (direto ou via Edge Function conforme .env)
    await saveUpdates(allUpdates);

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
