const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

puppeteer.use(StealthPlugin());

const cleanEnvVar = (val) => {
    if (!val) return val;
    let clean = val.trim();
    if ((clean.startsWith('"') && clean.endsWith('"')) || (clean.startsWith("'") && clean.endsWith("'"))) {
        clean = clean.substring(1, clean.length - 1).trim();
    }
    return clean;
};

const SUPABASE_URL = (() => {
    let url = cleanEnvVar(process.env.SUPABASE_URL);
    if (url && !url.startsWith('http')) {
        url = `https://${url}.supabase.co`;
    }
    return url;
})();
const SUPABASE_KEY = cleanEnvVar(process.env.SUPABASE_SERVICE_KEY) || cleanEnvVar(process.env.SUPABASE_KEY);

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ ERRO: SUPABASE_URL e SUPABASE_KEY / SUPABASE_SERVICE_KEY são obrigatórios no .env');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function formatDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/**
 * Tenta capturar imagens de lightbox de um quarto em uma data específica
 */
async function scrapePropertyRoomGalleries(page, property) {
    console.log(`\n🏨 [${property.name}] - Verificando disponibilidade de imagens...`);

    // Janelas de datas espaçadas a cada 2 dias para contornar restrições e diárias mínimas do Booking
    const dateOffsets = [2, 4, 6, 8, 14, 21];

    // 1. Buscar quartos no banco dessa propriedade que ainda necessitam de fotos
    const { data: dbRooms, error: roomErr } = await supabase
        .from('rooms')
        .select('id, name, images')
        .eq('property_id', property.id);

    if (roomErr || !dbRooms || dbRooms.length === 0) {
        console.log(`   ⚠️ Nenhum quarto cadastrado no banco para ${property.name}.`);
        return 0;
    }

    const roomsNeedingImages = dbRooms.filter(r => !r.images || !Array.isArray(r.images) || r.images.length === 0);
    if (roomsNeedingImages.length === 0) {
        console.log(`   ✅ Todos os ${dbRooms.length} quarto(s) desta propriedade já possuem galeria de imagens.`);
        return 0;
    }

    console.log(`   🎯 Quarto(s) pendente(s) de imagem: ${roomsNeedingImages.length} de ${dbRooms.length}`);

    let totalSaved = 0;

    for (const offset of dateOffsets) {
        // Se já preencheu todos os quartos pendentes, encerra a busca para este hotel
        const remainingNeeding = dbRooms.filter(r => !r.images || !Array.isArray(r.images) || r.images.length === 0);
        if (remainingNeeding.length === 0) break;

        const checkinDate = new Date();
        checkinDate.setDate(checkinDate.getDate() + offset);
        const checkoutDate = new Date(checkinDate);
        checkoutDate.setDate(checkoutDate.getDate() + 2); // 2 noites para aceitar diária mínima

        const checkinStr = formatDate(checkinDate);
        const checkoutStr = formatDate(checkoutDate);

        let targetUrl;
        try {
            targetUrl = new URL(property.source_url);
            targetUrl.searchParams.set('checkin', checkinStr);
            targetUrl.searchParams.set('checkout', checkoutStr);
            targetUrl.searchParams.set('group_adults', '2');
            targetUrl.searchParams.set('group_children', '0');
            targetUrl.searchParams.set('no_rooms', '1');
            targetUrl.searchParams.set('lang', 'pt-br');
            targetUrl.searchParams.set('selected_currency', 'BRL');
        } catch (e) {
            console.log(`   ❌ URL inválida para ${property.name}: ${property.source_url}`);
            return 0;
        }

        console.log(`   📅 Testando janela de data +${offset}d (${checkinStr} a ${checkoutStr})...`);

        try {
            await page.setCookie(
                { name: 'selected_currency', value: 'BRL', domain: '.booking.com', path: '/' },
                { name: 'currency', value: 'BRL', domain: '.booking.com', path: '/' },
                { name: 'lang', value: 'pt-br', domain: '.booking.com', path: '/' }
            );

            await page.goto(targetUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 35000 });
        } catch (err) {
            console.log(`   ⚠️ Falha ao carregar URL (offset +${offset}d): ${err.message}`);
            continue;
        }

        // Dispensar banners de cookies/GDPR se visíveis
        const cookieSelectors = [
            '#onetrust-accept-btn-handler',
            '[id*="accept"][id*="cookie"]',
            'button[data-gdpr-consent="accept"]',
            '.bui-button--primary[data-testid="accept-cookies-button"]',
        ];
        for (const sel of cookieSelectors) {
            try {
                await page.click(sel, { timeout: 2000 });
                await sleep(500);
                break;
            } catch (_) {}
        }

        await sleep(3000);
        await page.evaluate(() => window.scrollBy(0, 300));
        await sleep(1000);

        // Identificar elementos de quarto na tabela de disponibilidade e marcar com data-scraper-idx
        const pageRooms = await page.evaluate(() => {
            const table = document.querySelector('.hprt-table') ||
                          document.querySelector('[data-testid="availability-table"]') ||
                          document.querySelector('table[data-block="availability_table"]');

            if (!table) return [];

            let idxCounter = 0;
            const items = [];
            const rows = table.querySelectorAll('tr');

            for (const row of rows) {
                const nameEl = row.querySelector('.hprt-roomtype-icon-link, .hprt-roomtype-link, [data-room-name-en], .room-info, a[class*="roomtype"], a[class*="room-name"]');
                if (nameEl) {
                    const name = (nameEl.innerText || nameEl.textContent || '').trim();
                    if (name) {
                        if (!nameEl.hasAttribute('data-scraper-idx')) {
                            nameEl.setAttribute('data-scraper-idx', String(idxCounter++));
                        }
                        const idx = parseInt(nameEl.getAttribute('data-scraper-idx'), 10);
                        items.push({ name, idx });
                    }
                }
            }
            return items;
        });

        if (pageRooms.length === 0) {
            console.log(`   ⚠️ Tabela não disponível para a janela +${offset}d.`);
            continue;
        }

        console.log(`   🔍 Encontrados ${pageRooms.length} quartos na tabela do Booking.`);

        const processedIdx = new Set();

        for (const pr of pageRooms) {
            if (processedIdx.has(pr.idx)) continue;
            processedIdx.add(pr.idx);

            // Mapear com o quarto cadastrado no Supabase
            const dbRoom = dbRooms.find(r =>
                r.name.toLowerCase().trim() === pr.name.toLowerCase().trim() ||
                r.name.toLowerCase().includes(pr.name.toLowerCase()) ||
                pr.name.toLowerCase().includes(r.name.toLowerCase())
            );

            if (!dbRoom) continue;

            // Se este quarto já ganhou fotos em iteração anterior, ignora
            if (dbRoom.images && Array.isArray(dbRoom.images) && dbRoom.images.length > 0) continue;

            console.log(`   📸 Extraindo galeria do quarto: "${dbRoom.name}"...`);

            try {
                const triggerHandle = await page.$(`[data-scraper-idx="${pr.idx}"]`);
                if (!triggerHandle) continue;

                await page.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }), triggerHandle);
                await sleep(800);
                await triggerHandle.click();
                await triggerHandle.dispose();

                let extractedImages = [];
                for (let w = 0; w < 35; w++) {
                    extractedImages = await page.evaluate(() => {
                        const elements = Array.from(document.querySelectorAll('body *'));
                        const modals = elements.filter(el => {
                            if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(el.tagName)) return false;
                            const st = window.getComputedStyle(el);
                            const isPositioned = ['fixed', 'absolute'].includes(st.position);
                            const zIndex = parseInt(st.zIndex, 10);
                            return isPositioned && zIndex >= 100 && el.offsetHeight > 200 && el.offsetWidth > 200;
                        });

                        if (modals.length === 0) return [];

                        for (const modal of modals) {
                            const imgs = Array.from(modal.querySelectorAll('img')).map(img => {
                                return img.getAttribute('src') || img.getAttribute('data-lazy') ||
                                       img.getAttribute('data-highres') || img.srcset || '';
                            }).filter(src => src.includes('bstatic.com'))
                              .map(src => {
                                  return src.split(',')[0].trim().split(' ')[0]
                                      .replace('/square60/', '/max1024x768/')
                                      .replace('/max500/', '/max1024x768/');
                              }).filter(src => src.startsWith('http'));

                            if (imgs.length > 0) return Array.from(new Set(imgs));
                        }
                        return [];
                    });

                    if (extractedImages.length > 0) break;
                    await sleep(100);
                }

                if (extractedImages.length > 0) {
                    console.log(`     ✅ Salvas ${extractedImages.length} fotos para "${dbRoom.name}"!`);
                    
                    const { error: updateErr } = await supabase
                        .from('rooms')
                        .update({ images: extractedImages })
                        .eq('id', dbRoom.id);

                    if (!updateErr) {
                        dbRoom.images = extractedImages; // atualizar em memória
                        totalSaved++;
                    } else {
                        console.error(`     ❌ Erro ao salvar no Supabase: ${updateErr.message}`);
                    }
                } else {
                    console.log(`     ⚠️ Nenhuma foto extraída no modal para "${dbRoom.name}".`);
                }

                await page.keyboard.press('Escape').catch(() => {});
                await sleep(800);
            } catch (err) {
                console.log(`     ❌ Falha ao clicar no quarto "${pr.name}": ${err.message}`);
            }
        }

        // Intervalo amigável entre janelas de teste (3 a 5 segundos)
        await sleep(3000 + Math.floor(Math.random() * 2000));
    }

    return totalSaved;
}

async function runScraper() {
    console.log('══════════════════════════════════════════════════════════');
    console.log('   🖼️  ROBÔ DEDICADO DE GALERIAS DE QUARTOS (LOVABLE / SUPABASE)');
    console.log(`   ⏰ ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);
    console.log('══════════════════════════════════════════════════════════\n');

    // 1. Obter propriedades do Supabase
    let { data: properties, error: propErr } = await supabase
        .from('properties')
        .select('id, name, source_url');

    if (propErr || !properties || properties.length === 0) {
        console.error('❌ Erro ao carregar propriedades:', propErr?.message);
        return;
    }

    // Suporte a filtro por CLI: node room_gallery_scraper.js --property "Nome"
    const propFilterIdx = process.argv.indexOf('--property');
    if (propFilterIdx !== -1 && process.argv[propFilterIdx + 1]) {
        const filterVal = process.argv[propFilterIdx + 1].toLowerCase();
        properties = properties.filter(p => p.name.toLowerCase().includes(filterVal));
        console.log(`🔍 Filtrando por propriedade: "${process.argv[propFilterIdx + 1]}" (${properties.length} encontrada(s))\n`);
    }

    // 2. Identificar quartos pendentes de imagens
    const { data: allRooms } = await supabase
        .from('rooms')
        .select('property_id, images');

    const needyPropertyIds = new Set();
    (allRooms || []).forEach(r => {
        if (!r.images || !Array.isArray(r.images) || r.images.length === 0) {
            needyPropertyIds.add(r.property_id);
        }
    });

    const targetProperties = properties.filter(p => needyPropertyIds.has(p.id) && p.source_url && p.source_url.includes('booking.com'));
    console.log(`📊 Propriedades com quartos necessitando de imagens: ${targetProperties.length} de ${properties.length}`);

    if (targetProperties.length === 0) {
        console.log('🎉 Todas as propriedades e seus quartos já possuem galerias de imagens completas!');
        return;
    }

    console.log('🌐 Iniciando navegador Puppeteer em modo stealth...');
    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
        ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    let grandTotalSaved = 0;

    for (let i = 0; i < targetProperties.length; i++) {
        const prop = targetProperties[i];
        console.log(`\n[${i + 1}/${targetProperties.length}] 🏨 ${prop.name}`);

        const savedCount = await scrapePropertyRoomGalleries(page, prop);
        grandTotalSaved += savedCount;

        // Pausa entre propriedades para evitar bloqueio IP
        const pauseMs = 4000 + Math.floor(Math.random() * 3000);
        console.log(`   ⏳ Aguardando ${Math.round(pauseMs / 1000)}s antes do próximo hotel...`);
        await sleep(pauseMs);
    }

    await browser.close();

    console.log('\n══════════════════════════════════════════════════════════');
    console.log(`   ✅ Processamento concluído! ${grandTotalSaved} quarto(s) ganharam galeria de fotos.`);
    console.log('══════════════════════════════════════════════════════════\n');
}

runScraper().then(() => process.exit(0));
