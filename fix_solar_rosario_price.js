/**
 * FIX: Busca e atualiza o preço do Hotel Solar do Rosário
 * 
 * CAUSA RAIZ IDENTIFICADA:
 * O Booking.com usa lazy-load nos preços da tabela de disponibilidade.
 * Os nomes dos quartos são renderizados no HTML estático, mas os preços
 * só aparecem depois de um scroll adicional ou aguardar o carregamento 
 * dinâmico da coluna de preços (elemento .hprt-table-cell-price).
 * 
 * SOLUÇÃO: Aguardar especificamente o carregamento da coluna de preço
 * usando waitForFunction em vez de waitForSelector.
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { createClient } = require('@supabase/supabase-js');

puppeteer.use(StealthPlugin());

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const SOLAR_PROP_ID = '80302cc0-2ec8-4599-bbd8-2c1d23912ce6';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  console.log('🔍 FIX: Buscando preço atual do Hotel Solar do Rosário...');
  console.log('📅 Data/hora: ' + new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }));

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'pt-BR,pt;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  });
  await page.setCookie(
    { name: 'selected_currency', value: 'BRL', domain: '.booking.com', path: '/' },
    { name: 'currency', value: 'BRL', domain: '.booking.com', path: '/' },
    { name: 'lang', value: 'pt-br', domain: '.booking.com', path: '/' }
  );

  // NÃO bloquear imagens desta vez — o Booking pode usar imagens como gatilho de carregamento
  await page.setRequestInterception(true);
  page.on('request', req => {
    const t = req.resourceType();
    const url = req.url();
    if (t === 'font' || t === 'media') req.abort();
    else if (url.includes('google-analytics') || url.includes('doubleclick') || url.includes('facebook')) req.abort();
    else req.continue();
  });

  // Datas iguais ao scraper principal: checkin = hoje, checkout = hoje+2
  const checkin = new Date();
  const checkout = new Date(); checkout.setDate(checkout.getDate() + 2);
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  
  const url = `https://www.booking.com/hotel/br/solar-do-rosario.pt-br.html?aid=304142&checkin=${fmt(checkin)}&checkout=${fmt(checkout)}&group_adults=2&group_children=0&no_rooms=1&selected_currency=BRL&lang=pt-br&currency=BRL`;
  console.log('URL:', url);

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

  // Aceitar cookies
  try { await page.click('#onetrust-accept-btn-handler'); await sleep(600); } catch(_) {}

  // Aguardar tabela de disponibilidade
  try {
    await page.waitForSelector('.hprt-table', { timeout: 15000 });
    console.log('✅ Tabela de disponibilidade carregada.');
  } catch(_) {
    console.log('⚠️  Tabela não carregou em 15s — tentando continuar');
  }

  // Scroll progressivo para forçar lazy-load dos preços
  await page.evaluate(() => window.scrollBy(0, 500));
  await sleep(1000);
  await page.evaluate(() => window.scrollBy(0, 500));
  await sleep(1000);
  await page.evaluate(() => window.scrollBy(0, 300));
  await sleep(2000);

  // Aguardar especificamente o carregamento dos preços na coluna correta
  try {
    await page.waitForFunction(() => {
      const cells = document.querySelectorAll('.hprt-table-cell-price');
      return cells.length > 0 && [...cells].some(c => {
        const txt = c.innerText || c.textContent || '';
        return txt.includes('R$') || /\d{3,}/.test(txt);
      });
    }, { timeout: 15000 });
    console.log('✅ Preços carregados na tabela!');
  } catch(_) {
    console.log('⚠️  Preços não detectados via .hprt-table-cell-price — tentando extração completa');
  }

  // Extração completa dos quartos e preços
  const result = await page.evaluate(() => {
    const parsePriceText = (text) => {
      if (!text) return null;
      const cleanText = text.trim();
      const lower = cleanText.toLowerCase();
      if (lower.includes('café') || lower.includes('breakfast') || lower.includes('opcional') ||
          lower.includes('suplemento') || lower.includes('adicional') || lower.includes('taxa')) return null;
      if (!cleanText.includes('R$') && !/\d{3,}/.test(cleanText)) return null;
      const filtered = cleanText.replace(/[^0-9.,]/g, '');
      if (!filtered) return null;
      const hasDot = filtered.includes('.');
      const hasComma = filtered.includes(',');
      let priceVal;
      if (hasDot && hasComma) priceVal = parseFloat(filtered.replace(/\./g, '').replace(/,/g, '.'));
      else if (hasComma) priceVal = parseFloat(filtered.replace(/,/g, '.'));
      else if (hasDot) {
        const parts = filtered.split('.');
        if (parts[parts.length-1].length === 3) priceVal = parseFloat(filtered.replace(/\./g, ''));
        else priceVal = parseFloat(filtered);
      } else priceVal = parseFloat(filtered);
      if (isNaN(priceVal) || priceVal <= 0 || priceVal === 35) return null;
      return Math.round(priceVal * 100) / 100;
    };

    const table = document.querySelector('.hprt-table');
    if (!table) return { rooms: [], error: 'Tabela não encontrada no DOM' };

    const rooms = [];
    let currentRoomName = null;

    table.querySelectorAll('tr').forEach(row => {
      // Verifica se essa linha tem nome de quarto
      const nameEl = row.querySelector('.hprt-roomtype-icon-link, a[data-testid="rt-name-link"], .hprt-roomtype-link, [data-testid="room-type-name"], span.rt-room-title');
      if (nameEl) {
        currentRoomName = (nameEl.innerText || nameEl.textContent || '').trim();
      }

      // Buscar célula de preço
      const priceCell = row.querySelector('.hprt-table-cell-price, [data-cell-id*="price"]');
      if (priceCell && currentRoomName) {
        // Pegar preço com desconto (não riscado)
        let price = null;
        // Tentar selectors específicos de preço atual
        const priceSelectors = [
          '.bui-price-display__value',
          '.prco-valign-middle-helper',
          'span.prco-inline-block-maker-helper',
          '.prc-box-format__value',
          '[data-testid="price-and-discounted-price"]',
        ];
        for (const sel of priceSelectors) {
          const els = priceCell.querySelectorAll(sel);
          for (const el of els) {
            let p = el; let strike = false;
            while (p && p !== priceCell) {
              if (p.tagName === 'DEL' || p.tagName === 'S' || (p.className && p.className.includes && p.className.includes('strikethrough'))) { strike = true; break; }
              p = p.parentElement;
            }
            if (strike) continue;
            const txt = (el.innerText || el.textContent || '').trim();
            const parsed = parsePriceText(txt);
            if (parsed && parsed > 100) { price = parsed; break; }
          }
          if (price) break;
        }

        // Fallback: qualquer número na célula de preço
        if (!price) {
          const txt = (priceCell.innerText || priceCell.textContent || '').trim();
          price = parsePriceText(txt);
        }

        if (price && price > 100) {
          // Evitar duplicata do mesmo quarto
          const existing = rooms.find(r => r.room === currentRoomName);
          if (!existing) {
            rooms.push({ room: currentRoomName, price });
          }
        }
      }
    });

    // Debug: conteúdo completo das células de preço
    const priceCellsDebug = [...table.querySelectorAll('.hprt-table-cell-price')].slice(0, 5).map(c => (c.innerText || '').trim().slice(0, 100));

    return { rooms, priceCellsDebug };
  });

  console.log('\n📊 QUARTOS E PREÇOS ENCONTRADOS:');
  if (result.rooms.length > 0) {
    result.rooms.forEach(r => console.log(`  - ${r.room}: R$ ${r.price}`));
  } else {
    console.log('  Nenhum quarto com preço extraído.');
    console.log('  Debug células de preço:', JSON.stringify(result.priceCellsDebug));
    console.log('  Erro:', result.error || 'N/A');
  }

  // Atualizar banco se encontrou preços
  if (result.rooms.length > 0) {
    const now = new Date().toISOString();
    console.log('\n💾 Atualizando banco de dados...');

    // Buscar quartos existentes da propriedade
    const { data: dbRooms } = await supabaseAdmin.from('rooms').select('id, name, price').eq('property_id', SOLAR_PROP_ID);
    console.log('Quartos no banco:', (dbRooms || []).map(r => `${r.name} (R$${r.price})`).join(', '));

    const historyInserts = [];
    const updatedRoomPrices = [];

    for (const scraped of result.rooms) {
      const normScraped = scraped.room.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

      let match = (dbRooms || []).find(r => {
        const normDb = r.name.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        return normDb === normScraped || normDb.includes(normScraped) || normScraped.includes(normDb);
      });

      if (match) {
        updatedRoomPrices.push(scraped.price);
        if (match.price !== scraped.price) {
          await supabaseAdmin.from('rooms').update({ price: scraped.price }).eq('id', match.id);
          historyInserts.push({
            property_id: SOLAR_PROP_ID,
            room_id: match.id,
            room_name: match.name,
            old_price: match.price,
            new_price: scraped.price,
            checked_at: now,
            verified_at: now,
          });
          console.log(`   💰 "${match.name}": R$ ${match.price} → R$ ${scraped.price}`);
        } else {
          console.log(`   ✅ "${match.name}": sem alteração (R$ ${scraped.price})`);
        }
      } else {
        // Criar quarto novo
        const { data: newRoom } = await supabaseAdmin.from('rooms').insert({
          property_id: SOLAR_PROP_ID,
          name: scraped.room,
          price: scraped.price,
          adults: 2,
          children: 0,
          available: 1,
        }).select('id').single();
        if (newRoom) {
          updatedRoomPrices.push(scraped.price);
          historyInserts.push({
            property_id: SOLAR_PROP_ID,
            room_id: newRoom.id,
            room_name: scraped.room,
            old_price: 0,
            new_price: scraped.price,
            checked_at: now,
            verified_at: now,
          });
          console.log(`   🆕 Novo quarto criado: "${scraped.room}" (R$ ${scraped.price})`);
        }
      }
    }

    // Atualizar preço base da propriedade (menor preço ativo)
    const validPrices = updatedRoomPrices.filter(p => p >= 100);
    const minPrice = validPrices.length > 0 ? Math.min(...validPrices) : null;

    if (minPrice !== null) {
      await supabaseAdmin.from('properties').update({ price: minPrice, updated_at: now }).eq('id', SOLAR_PROP_ID);
      console.log(`\n🏨 Preço base da propriedade atualizado: R$ ${minPrice}`);

      // Identificar especificamente o Quarto Duplo Deluxe
      const duploDeLuxe = result.rooms.find(r => r.room.toLowerCase().includes('duplo') && r.room.toLowerCase().includes('deluxe'));
      if (duploDeLuxe) {
        console.log(`\n🎯 Quarto Duplo Deluxe: R$ ${duploDeLuxe.price}`);
      }
    }

    // Gravar histórico
    if (historyInserts.length > 0) {
      const { error: histErr } = await supabaseAdmin.from('price_history').insert(historyInserts);
      if (histErr) console.log('❌ Erro ao gravar histórico:', histErr.message);
      else console.log(`\n📋 ${historyInserts.length} entrada(s) gravada(s) no histórico de preços.`);
    }
  }

  await browser.close();
  console.log('\n✅ FIX concluído!');
})().catch(e => {
  console.error('ERRO FATAL:', e.message);
  process.exit(1);
});
