const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createClient } = require('@supabase/supabase-js');
const nodeFetch = require('node-fetch');
const path = require('path');

// Carregar variáveis de ambiente do .env
require('dotenv').config({ path: path.join(__dirname, '.env') });

puppeteer.use(StealthPlugin());

// ══════════════════════════════════════════════════════════════
//  CONFIGURAÇÃO
// ══════════════════════════════════════════════════════════════
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
const SUPABASE_KEY = cleanEnvVar(process.env.SUPABASE_KEY);               // anon key — leitura pública
const SUPABASE_SERVICE_KEY = cleanEnvVar(process.env.SUPABASE_SERVICE_KEY); // service role — escrita direta (opcional)
const BOT_API_KEY = cleanEnvVar(process.env.BOT_API_KEY) || 'booking-scraper-2026';
const INTERVALO_PADRAO_MS = 15 * 60 * 1000;

console.log(`DEBUG: SUPABASE_URL = "${SUPABASE_URL}" (length: ${SUPABASE_URL ? SUPABASE_URL.length : 0})`);
console.log(`DEBUG: SUPABASE_KEY is set: ${!!SUPABASE_KEY} (length: ${SUPABASE_KEY ? SUPABASE_KEY.length : 0})`);


if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ ERRO: SUPABASE_URL e SUPABASE_KEY são obrigatórios no .env');
    process.exit(1);
}

// Anon key — leitura de propriedades aprovadas
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    global: { fetch: nodeFetch }
});

// Service Role Key — grava direto nas tabelas sem RLS (preferencial)
// Se não estiver no .env, o robô usa a Edge Function como fallback.
const supabaseAdmin = SUPABASE_SERVICE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
        global: { fetch: nodeFetch }
    })
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

// Dicionário estático das 28 propriedades conhecidas e seus respectivos links do Booking.com
const KNOWN_BOOKING_LINKS = {
    "hotel recanto do ouro": "https://www.booking.com/hotel/br/recanto-da-serra-ouro-preto.pt-br.html?aid=304142",
    "hotel solar das lajes": "https://www.booking.com/hotel/br/solar-das-lajes.pt-br.html?aid=304142",
    "hotel pousada minas gerais": "https://www.booking.com/hotel/br/pousada-minas-gerais.pt-br.html?aid=304142",
    "pousada nossa senhora das merces": "https://www.booking.com/hotel/br/pousada-solar-nossa-senhora-das-merces.pt-br.html?aid=304142",
    "pousada solar nossa senhora das merces": "https://www.booking.com/hotel/br/pousada-solar-nossa-senhora-das-merces.pt-br.html?aid=304142",
    "hotel solar de maria": "https://www.booking.com/hotel/br/solar-de-maria.pt-br.html?aid=304142",
    "pousada solar das gerais": "https://www.booking.com/hotel/br/pertin-da-praca-hostel.pt-br.html?aid=304142",
    "pousada arcadia mineira": "https://www.booking.com/hotel/br/arcadia-mineira.pt-br.html?aid=304142",
    "hotel pousada arcadia mineira": "https://www.booking.com/hotel/br/arcadia-mineira.pt-br.html?aid=304142",
    "pousada solar da inconfidencia": "https://www.booking.com/hotel/br/pousada-toledo.pt-br.html?aid=304142",
    "pousada do mondego": "https://www.booking.com/hotel/br/pousada-do-mondego.pt-br.html?aid=304142",
    "casa dos meninos b&b": "https://www.booking.com/hotel/br/casa-dos-meninos-b-amp-b.pt-br.html?aid=304142",
    "pousada do ouvidor": "https://www.booking.com/hotel/br/pousada-do-ouvidor.pt-br.html?aid=304142",
    "mirante hotel": "https://www.booking.com/hotel/br/mirante-ouro-preto.pt-br.html?aid=360920",
    "pousada lacos de minas": "https://www.booking.com/hotel/br/pousada-lacos-de-minas.pt-br.html?aid=360920",
    "pousada sinha olimpia": "https://www.booking.com/hotel/br/pousada-sinha-olimpia-ouro-preto.pt-br.html?aid=304142",
    "boroni palace hotel": "https://www.booking.com/hotel/br/boroni-palace.pt-br.html?aid=304142",
    "hotel priskar": "https://www.booking.com/hotel/br/priskar.pt-br.html?aid=304142",
    "hotel pousada classica": "https://www.booking.com/hotel/br/pousada-cla-ssica.pt-br.html?aid=304142",
    "grande hotel de ouro preto": "https://www.booking.com/hotel/br/grande-hotel-de-ouro-preto.pt-br.html?aid=304142",
    "grande hotel ouro preto": "https://www.booking.com/hotel/br/grande-hotel-de-ouro-preto.pt-br.html?aid=304142",
    "hotel solar do rosario": "https://www.booking.com/hotel/br/solar-do-rosario.pt-br.html?aid=304142",
    "pousada casa dos contos": "https://www.booking.com/hotel/br/pousada-casa-dos-contos.pt-br.html?aid=304142",
    "hotel pousada casa grande": "https://www.booking.com/hotel/br/pousada-casa-grande-ouro-preto.pt-br.html?aid=304142",
    "pousada dos oficios": "https://www.booking.com/hotel/br/pousada-dos-oficios.pt-br.html?aid=304142",
    "chale vila catarina": "https://www.booking.com/hotel/br/pousada-vila-catarina-ouro-preto2.pt-br.html?aid=304142",
    "hotel luxor": "https://www.booking.com/hotel/br/luxor-ouro-preto-pousada.pt-br.html?aid=304142",
    "pousada caminhos da liberdade": "https://www.booking.com/hotel/br/pousada-caminhos-da-liberdade.pt-br.html?aid=304142",
    "caminhos da liberdade pousada": "https://www.booking.com/hotel/br/pousada-caminhos-da-liberdade.pt-br.html?aid=304142",
    "pousada dos bandeirantes": "https://www.booking.com/hotel/br/pousada-dos-bandeirantes.pt-br.html?aid=304142",
    "pousada memorias de minas": "https://www.booking.com/hotel/br/pousada-memorias-de-minas.pt-br.html?aid=304142",
    "pousada inconfidencia mineira": "https://www.booking.com/hotel/br/pousada-inconfidaancia-mineira.pt-br.html?aid=304142",
    "pouso jardim de assis": "https://www.booking.com/hotel/br/pouso-jardim-de-assis.pt-br.html?aid=304142",
    "hotel pousada do arcanjo": "https://www.booking.com/hotel/br/arcanjo.pt-br.html?aid=360920",
    "pousada colonial": "https://www.booking.com/hotel/br/pousada-colonial-ouro-preto.pt-br.html?aid=304142",
    "hotel colonial": "https://www.booking.com/hotel/br/pousada-colonial-ouro-preto.pt-br.html?aid=304142",
    "vila gale collection ouro preto": "https://www.booking.com/hotel/br/vila-gale-collection-ouro.pt-br.html?aid=304142"
};

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

    const clientToUse = supabaseAdmin || supabase;

    // Auto-linkagem de propriedades com URL ausente ou incorreta
    for (const p of (properties || [])) {
        const hasValidUrl = p.source_url && p.source_url.includes('booking.com');
        if (!hasValidUrl) {
            const key = normalize(p.name);
            const knownLink = KNOWN_BOOKING_LINKS[key];
            if (knownLink) {
                console.log(`   🔗 Auto-linkagem: Propriedade "${p.name}" sem link válido. Atualizando com link do Booking...`);
                try {
                    const { error: updateError } = await clientToUse
                        .from('properties')
                        .update({ source_url: knownLink })
                        .eq('id', p.id);
                    if (updateError) {
                        console.warn(`   ⚠️ Falha ao salvar link para "${p.name}":`, updateError.message);
                    } else {
                        p.source_url = knownLink;
                        console.log(`   ✅ Link atualizado no banco para "${p.name}"!`);
                    }
                } catch (err) {
                    console.warn(`   ⚠️ Erro ao salvar link para "${p.name}":`, err.message);
                }
            }
        }
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
async function saveUpdates(updates, checkedPropIds = []) {
    if (supabaseAdmin) {
        await updateSupabaseDirectly(updates, checkedPropIds);
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

// Algoritmo Próprio de Avaliação ("Score Ouro Preto / IQH")
function calculateProprietaryScore(prop) {
    const rawScore = Number(prop.review_score) || Number(prop.seed_review_score) || 8.5;
    const rawCount = Number(prop.review_count) || Number(prop.seed_review_count) || 50;
    const dist = Number(prop.distance_from_center) || 1.0;
    const amenities = Array.isArray(prop.amenities) ? prop.amenities : [];
    const price = Number(prop.price) || 0;

    // 1. Satisfação Ajustada (Suavização Bayesiana) - Peso 45%
    const m = 15;
    const C = 8.5;
    const bayesianScore = (rawCount * rawScore + m * C) / (rawCount + m);

    // 2. Nota de Localização Histórica (0 a 10) - Peso 25%
    let locationScore = 10;
    if (dist > 0.5) {
        locationScore = Math.max(6.0, 10 - (dist - 0.5) * 1.2);
    }
    locationScore = Math.round(locationScore * 10) / 10;

    // 3. Nota de Infraestrutura e Comodidades (0 a 10) - Peso 15%
    let amenitiesScore = 7.0;
    if (amenities.length > 0) {
        amenitiesScore += Math.min(2.5, amenities.length * 0.4);
    }
    const keyAmenities = ['wifi', 'estacionamento', 'café da manhã', 'acessibilidade', 'pet friendly', 'recepção 24h'];
    const lowerAmenities = amenities.map(a => String(a).toLowerCase());
    for (const key of keyAmenities) {
        if (lowerAmenities.some(a => a.includes(key))) {
            amenitiesScore += 0.2;
        }
    }
    amenitiesScore = Math.min(10.0, Math.round(amenitiesScore * 10) / 10);

    // 4. Nota de Custo-Benefício (0 a 10) - Peso 15%
    let valueScore = 8.5;
    if (price > 0) {
        if (price < 350) valueScore = 9.5;
        else if (price < 500) valueScore = 9.0;
        else if (price < 800) valueScore = 8.5;
        else valueScore = 8.0;
    }
    valueScore = Math.round(valueScore * 10) / 10;

    const customScoreRaw = (bayesianScore * 0.45) + (locationScore * 0.25) + (amenitiesScore * 0.15) + (valueScore * 0.15);
    const customScore = Math.round(customScoreRaw * 10) / 10;
    const customStars = Math.round((customScore / 2) * 10) / 10;

    let qualityBadge = 'Bom Custo-Benefício';
    if (customScore >= 9.2) {
        qualityBadge = 'Ouro Preto Select 💎';
    } else if (customScore >= 8.6) {
        qualityBadge = 'Excelência Histórica 🏅';
    } else if (customScore >= 8.0) {
        qualityBadge = 'Muito Recomendado 👍';
    }

    const subScores = {
        reputation: Math.round(bayesianScore * 10) / 10,
        location: locationScore,
        amenities: amenitiesScore,
        value: valueScore
    };

    return {
        custom_score: customScore,
        custom_stars: customStars,
        quality_badge: qualityBadge,
        sub_scores: subScores
    };
}

async function updateSupabaseDirectly(updates, checkedPropIds = []) {
    if (updates.length === 0 && checkedPropIds.length === 0) {
        console.log('ℹ️  Nenhuma atualização para gravar.');
        return;
    }

    const now = new Date().toISOString();

    // Atualizar timestamp updated_at para TODAS as propriedades verificadas nesta rodada
    if (checkedPropIds && checkedPropIds.length > 0) {
        const { error: tsErr } = await supabaseAdmin
            .from('properties')
            .update({ updated_at: now })
            .in('id', checkedPropIds);
        if (tsErr) {
            console.warn(`   ⚠️ Erro ao atualizar timestamp de verificação: ${tsErr.message}`);
        } else {
            console.log(`   🕒 Timestamps (updated_at) de ${checkedPropIds.length} propriedade(s) verificada(s) atualizados.`);
        }
    }

    if (updates.length === 0) {
        console.log('ℹ️  Nenhuma alteração de preço para gravar.');
        return;
    }

    console.log(`\n💾 Gravando ${updates.length} entrada(s) diretamente no Supabase...`);

    // Carrega propriedades e quartos existentes
    const { data: properties, error: propErr } = await supabaseAdmin
        .from('properties').select('id, name, price, source_url, review_score, review_count, distance_from_center, amenities, seed_review_score, seed_review_count');
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
            // Propriedade esgotada para a data de hoje: atualiza preço base para 0 e marca quartos como 0 (Esgotado)
            const ratingData = calculateProprietaryScore({ ...prop, price: 0 });
            await supabaseAdmin.from('properties').update({ 
                price: 0, 
                source_url: latestSourceUrl,
                updated_at: now,
                ...ratingData
            }).eq('id', propId);

            // Atualiza quartos existentes no banco para preço 0 (Esgotado para hoje)
            for (const r of propRooms) {
                if (r.price > 0) {
                    await supabaseAdmin.from('rooms').update({ price: 0 }).eq('id', r.id);
                    historyInserts.push({
                        property_id: propId,
                        room_id: r.id,
                        room_name: r.name,
                        old_price: r.price,
                        new_price: 0,
                        source_url: latestSourceUrl,
                        checked_at: now,
                        verified_at: now,
                    });
                }
            }

            if (prop.price !== 0) {
                historyInserts.push({
                    property_id: propId,
                    room_id: null,
                    room_name: 'Esgotado para hoje',
                    old_price: prop.price,
                    new_price: 0,
                    source_url: latestSourceUrl,
                    checked_at: now,
                    verified_at: now,
                });
                changesCount++;
            }
            console.log(`   🚫 ${prop.name}: Esgotado para hoje (preço atualizado para R$ 0 no Supabase).`);
            continue;
        }

        // Processa quartos ativos
        const updatedRoomIds = new Set();
        const activeRoomPrices = [];

        for (const update of propUpdates) {
            const { room_name, price, adults, children, source_url, images } = update;
            if (price <= 0 || update.status === 'sold_out') continue;

            const normalizedRoom = normalize(room_name || 'geral');
            let matchedRoom;

            // 1) Match exato de nome normalizado e capacidade (evitando duplicar o mesmo quarto físico)
            for (const r of propRooms) {
                if (updatedRoomIds.has(r.id)) continue;
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
                    if (updatedRoomIds.has(r.id)) continue;
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
                if (images && images.length > 0) updateData.images = images;

                if (matchedRoom.price !== price || matchedRoom.adults !== adults || matchedRoom.children !== children || (images && images.length > 0)) {
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
                    available: 1,
                    images: images || null
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

        // 3) Zerar preço de quartos antigos não atualizados na rodada atual ou com valores anômalos (< R$ 100)
        for (const r of propRooms) {
            if (!updatedRoomIds.has(r.id) || r.price < 100) {
                if (r.price > 0) {
                    await supabaseAdmin.from('rooms').update({ price: 0 }).eq('id', r.id);
                    console.log(`   🧹 ${prop.name} / ${r.name}: preço antigo de R$ ${r.price} limpo (atualizado para R$ 0)`);
                }
            }
        }

        // Atualiza preço base da propriedade com o menor preço ativo da rodada (filtrando anomalias < R$ 100), URL, timestamp de verificação (updated_at) e o Score Ouro Preto autoral
        const validRoomPrices = activeRoomPrices.filter(p => p >= 100);
        const minPrice = validRoomPrices.length > 0 ? Math.min(...validRoomPrices) : 0;
        const ratingData = calculateProprietaryScore({ ...prop, price: minPrice });

        await supabaseAdmin.from('properties').update({ 
            price: minPrice, 
            source_url: latestSourceUrl,
            updated_at: now,
            ...ratingData
        }).eq('id', propId);

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
            console.log(`   🏨 ${prop.name}: preço base atualizado no Supabase (R$ ${prop.price} → R$ ${minPrice})`);
        } else {
            console.log(`   🏨 ${prop.name}: preço base sem alteração (R$ ${minPrice}) - timestamp de verificação atualizado.`);
        }
    }

    // Gravação dos históricos acumulados em um único comando insert em lote
    if (historyInserts.length > 0) {
        const { error } = await supabaseAdmin.from('price_history').insert(historyInserts);
        if (error) {
            console.error('❌ Erro ao gravar histórico de preços em lote:', error.message);
        }
    }

    // Limpeza de histórico antigo para economizar espaço (mantém apenas a última hora)
    try {
        const cutOffTime = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
        const { error: cleanErr } = await supabaseAdmin
            .from('price_history')
            .delete()
            .lt('checked_at', cutOffTime);
        if (cleanErr) {
            console.error('❌ Erro ao limpar histórico antigo:', cleanErr.message);
        } else {
            console.log('   🧹 Histórico com mais de 1 hora limpo com sucesso.');
        }
    } catch (err) {
        console.error('❌ Erro na rotina de limpeza:', err.message);
    }

    console.log(`\n✅ ${changesCount} alteração(ões) gravada(s) diretamente no Supabase.`);
}

// ══════════════════════════════════════════════════════════════
//  SCRAPING PRINCIPAL (Otimizado com Concorrência e Retries)
// ══════════════════════════════════════════════════════════════

// Otimização: Interceptador de requisições para bloquear mídias pesadas e rastreadores
async function setupPageOptimizations(page) {
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        const resourceType = req.resourceType();
        const url = req.url().toLowerCase();

        if (
            resourceType === 'font' ||
            resourceType === 'media' ||
            url.includes('google-analytics') ||
            url.includes('doubleclick') ||
            url.includes('facebook') ||
            url.includes('analytics') ||
            url.includes('gtm.js')
        ) {
            req.abort();
        } else {
            req.continue();
        }
    });
}

// Raspagem de propriedade individual com Retries (re-tentativas automáticas)
async function scrapePropertyWithRetry(browser, prop, index, totalProps, checkinDate, checkoutDate) {
    const MAX_RETRIES = 2;
    let attempt = 0;

    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    ];

    let urlToScrape;
    try {
        urlToScrape = new URL(prop.source_url.trim());
        const originalAdults = urlToScrape.searchParams.get('group_adults') || urlToScrape.searchParams.get('req_adults');
        const originalChildren = urlToScrape.searchParams.get('group_children') || urlToScrape.searchParams.get('req_children');
        const originalNoRooms = urlToScrape.searchParams.get('no_rooms');
        const originalRoom1 = urlToScrape.searchParams.get('room1');

        urlToScrape.search = '';
        urlToScrape.hash = '';

        const p = urlToScrape.pathname;
        if (/\.[a-z]{2}(?:-[a-z]{2})?\.html$/i.test(p)) {
            urlToScrape.pathname = p.replace(/\.[a-z]{2}(?:-[a-z]{2})?\.html$/i, '.pt-br.html');
        } else if (p.endsWith('.html')) {
            urlToScrape.pathname = p.replace(/\.html$/i, '.pt-br.html');
        } else {
            urlToScrape.pathname = p.replace(/\/$/, '') + '.pt-br.html';
        }
        urlToScrape.searchParams.set('lang', 'pt-br');
        urlToScrape.searchParams.set('selected_currency', 'BRL');
        urlToScrape.searchParams.set('currency', 'BRL');
        urlToScrape.searchParams.set('checkin', checkinDate);
        urlToScrape.searchParams.set('checkout', checkoutDate);
        urlToScrape.searchParams.set('group_adults', originalAdults || '2');
        urlToScrape.searchParams.set('group_children', originalChildren || '0');
        urlToScrape.searchParams.set('no_rooms', originalNoRooms || '1');
        if (originalRoom1) urlToScrape.searchParams.set('room1', originalRoom1);
    } catch (e) {
        console.log(`   ❌ [${index + 1}/${totalProps}] ${prop.name}: URL inválida -> ${prop.source_url}`);
        return { status: 'INVALID_URL', updates: [], prop };
    }

    while (attempt < MAX_RETRIES) {
        attempt++;
        let currentCheckin = checkinDate;
        let currentCheckout = checkoutDate;

        if (attempt > 1) {
            // Re-tentativa para a MESMA data (hoje) com novo User Agent / aba limpa
            urlToScrape.searchParams.set('checkin', checkinDate);
            urlToScrape.searchParams.set('checkout', checkoutDate);
        }

        const attemptLabel = attempt > 1 ? ` 🔄 (Re-tentativa ${attempt}/${MAX_RETRIES})` : '';
        console.log(`[${index + 1}/${totalProps}] 🏨 ${prop.name}${attemptLabel}`);

        let page;
        try {
            page = await browser.newPage();
            await page.setViewport({ width: 1280, height: 800 });
            await setupPageOptimizations(page);
            await page.setUserAgent(userAgents[(index + attempt) % userAgents.length]);

            await page.setExtraHTTPHeaders({
                'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            });

            await page.setCookie(
                { name: 'selected_currency', value: 'BRL', domain: '.booking.com', path: '/' },
                { name: 'currency', value: 'BRL', domain: '.booking.com', path: '/' },
                { name: 'lang', value: 'pt-br', domain: '.booking.com', path: '/' },
                { name: 'language', value: 'pt-br', domain: '.booking.com', path: '/' }
            );

            await page.goto(urlToScrape.toString(), { waitUntil: 'domcontentloaded', timeout: 35000 });
            const currentUrl = page.url() || urlToScrape.toString();

            const cookieSelectors = [
                '#onetrust-accept-btn-handler',
                '[id*="accept"][id*="cookie"]',
                'button[data-gdpr-consent="accept"]',
                '.bui-button--primary[data-testid="accept-cookies-button"]',
            ];
            for (const sel of cookieSelectors) {
                try {
                    await page.click(sel, { timeout: 2000 });
                    await sleep(400);
                    break;
                } catch (_) {}
            }

            // Otimizado para 2-3s com bloqueio de mídia ativado
            const waitTime = 2000 + Math.floor(Math.random() * 1000);
            await sleep(waitTime);

            try {
                await page.waitForSelector(
                    '.hprt-table, [data-testid="availability-table"], table[data-block="availability_table"]',
                    { timeout: 10000 }
                );
            } catch (_) {
                console.log(`   ⚠️ [${prop.name}] Tabela de disponibilidade não carregou no tempo — tentando extrair assim mesmo`);
            }

            // ── CORREÇÃO: Scroll progressivo para forçar lazy-load dos preços ──
            // O Booking.com carrega os preços da coluna .hprt-table-cell-price
            // de forma assíncrona APÓS a tabela já estar no DOM.
            // Sem os scrolls abaixo, a coluna de preços chega vazia.
            await page.evaluate(() => window.scrollBy(0, 400));
            await sleep(600);
            await page.evaluate(() => window.scrollBy(0, 400));
            await sleep(600);

            // Aguardar especificamente que os preços sejam populados no DOM
            try {
                await page.waitForFunction(() => {
                    const cells = document.querySelectorAll('.hprt-table-cell-price, [data-cell-id*="price"]');
                    return cells.length > 0 && [...cells].some(c => {
                        const txt = (c.innerText || c.textContent || '').trim();
                        return /R\$/.test(txt) || /\d{3,}/.test(txt);
                    });
                }, { timeout: 8000 });
            } catch (_) {
                console.log(`   ⚠️ [${prop.name}] Preços não detectados na tabela após scroll — prosseguindo com extração`);
            }

            await page.evaluate(() => window.scrollBy(0, 200));
            await sleep(400);

            const data = await page.evaluate(async () => {
                const parsePriceText = (text) => {
                    if (!text) return null;
                    const cleanText = text.trim();
                    if (!cleanText.includes('R$') && !cleanText.includes('$')) return null;

                    // Descartar explicitamente textos referentes a adicionais como café da manhã, taxas e suplementos
                    const lower = cleanText.toLowerCase();
                    if (lower.includes('café') || lower.includes('breakfast') || lower.includes('opcional') || 
                        lower.includes('suplemento') || lower.includes('adicional') || lower.includes('taxa')) {
                        return null;
                    }

                    const filtered = cleanText.replace(/[^0-9.,]/g, '');
                    if (!filtered) return null;
                    
                    let priceVal = null;
                    const hasDot = filtered.includes('.');
                    const hasComma = filtered.includes(',');
                    
                    if (hasDot && hasComma) {
                        // Formato brasileiro com milhar e centavos: 1.450,00 -> 1450.00
                        priceVal = parseFloat(filtered.replace(/\./g, '').replace(/,/g, '.'));
                    } else if (hasComma) {
                        // Formato com vírgula decimal: 450,00 -> 450.00
                        priceVal = parseFloat(filtered.replace(/,/g, '.'));
                    } else if (hasDot) {
                        const parts = filtered.split('.');
                        if (parts[parts.length - 1].length === 3) {
                            // Ponto de milhar: 1.450 -> 1450
                            priceVal = parseFloat(filtered.replace(/\./g, ''));
                        } else {
                            // Ponto decimal: 450.00 -> 450.00
                            priceVal = parseFloat(filtered);
                        }
                    } else {
                        priceVal = parseFloat(filtered);
                    }
                    
                    if (isNaN(priceVal) || priceVal < 100) return null;

                    const finalPrice = Math.round(priceVal * 100) / 100;

                    // Bloqueio definitivo de taxas adicionais (ex: café da manhã R$ 35,00)
                    if (finalPrice < 100) {
                        return null;
                    }

                    return finalPrice;
                };

                const getRowPrice = (row) => {
                    // Isolamento estrito da COLUNA 2 (Preço de hoje: .hprt-table-cell-price)
                    // Descarta 100% a Coluna 3 de condições (.hprt-table-cell-conditions) onde fica o "Café da manhã R$ 35"
                    const priceCell = row.querySelector('.hprt-table-cell-price, [data-cell-id*="price"]') ||
                                      Array.from(row.children).find(td => {
                                          if (!td || !td.className) return false;
                                          const cls = td.className.toString().toLowerCase();
                                          return cls.includes('hprt-table-cell-price') || (cls.includes('price') && !cls.includes('conditions') && !cls.includes('roomtype') && !cls.includes('select'));
                                      });

                    if (!priceCell) return null;

                    // Rejeita explicitamente se a célula capturada for de condições/serviços adicionais
                    const cellClass = (priceCell.className || '').toString().toLowerCase();
                    if (cellClass.includes('conditions')) return null;

                    const searchContext = priceCell;

                    const activePriceSelectors = [
                        '.bui-price-display__value',
                        '.prc-box-format__value',
                        '[data-testid="price-and-discounted-price"]',
                        '.prco-valign-middle-helper',
                        'span.prco-inline-block-maker-helper',
                        '[data-testid="price-display-value"]',
                        '.prco-text-nowrap-helper'
                    ];

                    for (const sel of activePriceSelectors) {
                        const els = searchContext.querySelectorAll(sel);
                        for (const el of els) {
                            let parent = el;
                            let isStrikethrough = false;
                            while (parent && parent !== searchContext) {
                                if (parent.tagName === 'DEL' || parent.tagName === 'S' ||
                                    (parent.className && typeof parent.className === 'string' && 
                                     (parent.className.includes('strikethrough') || parent.className.includes('original') || parent.className.includes('old')))) {
                                    isStrikethrough = true;
                                    break;
                                }
                                parent = parent.parentElement;
                            }
                            if (isStrikethrough) continue;

                            const txt = (el.innerText || el.textContent || '').trim();
                            const price = parsePriceText(txt);
                            if (price !== null && !isNaN(price) && price >= 100) {
                                return price;
                            }
                        }
                    }

                    // Se os seletores internos não retornarem, extrai do texto direto da célula de preço
                    const rawCellText = (searchContext.innerText || searchContext.textContent || '').trim();
                    const directPrice = parsePriceText(rawCellText);
                    if (directPrice !== null && !isNaN(directPrice) && directPrice >= 100) {
                        return directPrice;
                    }

                    return null;
                };

                const extractAllRooms = async () => {
                    const table = document.querySelector('.hprt-table') ||
                                  document.querySelector('[data-testid="availability-table"]') ||
                                  document.querySelector('table[data-block="availability_table"]');
                    if (!table) return [];

                    const roomMap = new Map();
                    let currentRoomName = null;
                    let currentRoomCell = null;

                    const rows = table.querySelectorAll('tr');
                    let roomNameIdx = 0;
                    let currentScraperIdx = -1;
                    for (const row of rows) {
                        const roomNameEl = row.querySelector(
                            'a[data-testid="rt-name-link"], .hprt-roomtype-link, [data-testid="room-type-name"], [data-testid="roomtype-name"], .hprt-roomtype-icon-link, .room-name, span.rt-room-title, [data-cell-id*="room_type"] a, a[href*="#rd-"]'
                        );
                        if (roomNameEl) {
                            const txt = (roomNameEl.innerText || roomNameEl.textContent || '').trim();
                            if (txt) {
                                currentRoomName = txt;
                                currentRoomCell = roomNameEl.closest('td') || roomNameEl.closest('th') || roomNameEl.parentElement;
                                if (!roomNameEl.hasAttribute('data-scraper-idx')) {
                                    roomNameEl.setAttribute('data-scraper-idx', String(roomNameIdx++));
                                }
                                currentScraperIdx = parseInt(roomNameEl.getAttribute('data-scraper-idx'));
                            }
                        }

                        if (!currentRoomName) continue;

                        let adults = 2;
                        let children = 0;

                        const occupancyEl = row.querySelector(
                            '.hprt-occupancy, [data-testid="occupancy-column"], [data-testid="occupancy-icon-group"], .bui-icon--occupancy, .occupancy-container, [class*="occupancy"], [class*="capacity"], [class*="people"]'
                        );

                        if (occupancyEl) {
                            const icons = occupancyEl.querySelectorAll('.bui-icon--occupancy, i[class*="user"], svg[class*="user"], .occupancy-icon');
                            const childIcons = occupancyEl.querySelectorAll('.bui-icon--child, i[class*="child"], svg[class*="child"], .child-icon');
                            
                            const srEl = occupancyEl.querySelector('.sr-only, .visually-hidden');
                            const textToSearch = (srEl ? (srEl.innerText || srEl.textContent) : (occupancyEl.innerText || occupancyEl.textContent || occupancyEl.getAttribute('title') || '')).toLowerCase();
                            
                            let adultMatch = textToSearch.match(/(\d+)\s*(?:adulto|pessoa|guest|hospede|adult|pax)/i);
                            if (!adultMatch) {
                                adultMatch = textToSearch.match(/(?:adulto|pessoa|guest|hospede|adult|pax)s?\s*[:\-\s]\s*(\d+)/i);
                            }
                            let childMatch = textToSearch.match(/(\d+)\s*(?:crianca|child|menor)/i);
                            if (!childMatch) {
                                childMatch = textToSearch.match(/(?:crianca|child|menor)es?\s*[:\-\s]\s*(\d+)/i);
                            }

                            if (icons.length > 0) {
                                adults = icons.length;
                                children = childIcons.length;
                            } else if (adultMatch) {
                                adults = parseInt(adultMatch[1]);
                                if (childMatch) children = parseInt(childMatch[1]);
                            } else {
                                const dataOcc = occupancyEl.getAttribute('data-occupancy') || 
                                                 occupancyEl.getAttribute('data-capacity') ||
                                                 occupancyEl.getAttribute('data-max-occupancy');
                                if (dataOcc && !isNaN(parseInt(dataOcc))) {
                                    adults = parseInt(dataOcc);
                                }
                            }
                        } else {
                            const textToSearch = (row.innerText || row.textContent || '').toLowerCase();
                            const adultMatch = textToSearch.match(/(\d+)\s*(?:adulto|pessoa|guest|hospede|adult|pax)/i);
                            const childMatch = textToSearch.match(/(\d+)\s*(?:crianca|child|menor)/i);
                            if (adultMatch) adults = parseInt(adultMatch[1]);
                            if (childMatch) children = parseInt(childMatch[1]);
                        }

                        const rowPrice = getRowPrice(row);

                        if (rowPrice !== null) {
                            if (adults !== 2 || children !== 0) {
                                continue;
                            }

                            let inlineImages = [];
                            if (currentRoomCell) {
                                inlineImages = Array.from(currentRoomCell.querySelectorAll('img')).map(img => {
                                    const src = img.getAttribute('src') || img.getAttribute('data-lazy') || img.getAttribute('data-highres') || '';
                                    return src.replace('/square60/', '/max1024x768/').replace('/max500/', '/max1024x768/');
                                }).filter(src => src.startsWith('http'));
                            }

                            const optionKey = `${currentRoomName}_${adults}_${children}`;
                            if (!roomMap.has(optionKey) || rowPrice < roomMap.get(optionKey).price) {
                                roomMap.set(optionKey, { name: currentRoomName, price: rowPrice, adults, children, images: inlineImages, scraperIdx: currentScraperIdx });
                            }
                        }
                    }

                    for (const key of Array.from(roomMap.keys())) {
                        if (key.endsWith('_1_0')) {
                            const roomBaseName = key.slice(0, -4);
                            const doubleKey = `${roomBaseName}_2_0`;
                            if (roomMap.has(doubleKey)) {
                                roomMap.delete(key);
                            }
                        }
                    }

                    return Array.from(roomMap.values()).sort((a, b) => a.price - b.price);
                };

                const rooms = await extractAllRooms();

                let lowestTablePrice = null;
                const table = document.querySelector('.hprt-table') ||
                              document.querySelector('[data-testid="availability-table"]') ||
                              document.querySelector('table[data-block="availability_table"]');
                if (table) {
                    const rows = table.querySelectorAll('tr');
                    for (const row of rows) {
                        const price = getRowPrice(row);
                        if (price !== null && !isNaN(price) && price >= 100) {
                            if (lowestTablePrice === null || price < lowestTablePrice) {
                                lowestTablePrice = price;
                            }
                        }
                    }
                }

                if (rooms.length > 0) {
                    return { rooms, lowestTablePrice, isSoldOut: false };
                }

                const bodyText = document.body.innerText || document.body.textContent || '';
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
            const propUpdates = [];
            const nightsCount = Math.max(1, Math.round((new Date(checkoutDate) - new Date(checkinDate)) / (1000 * 60 * 60 * 24))) || 2;

            if (rooms.length === 0 && lowestTablePrice > 0) {
                const nightlyLowestPrice = Math.round((lowestTablePrice / nightsCount) * 100) / 100;
                console.log(`   📋 Nenhum quarto estruturado, menor diária da tabela: R$ ${nightlyLowestPrice}`);
                propUpdates.push({
                    property_id: prop.id,
                    property_name: prop.name,
                    room_name: 'Preço Base (Tabela)',
                    price: nightlyLowestPrice,
                    adults: 2,
                    children: 0,
                    source_url: currentUrl,
                    status: 'available',
                });
            } else if (rooms.length === 0) {
                if (attempt < MAX_RETRIES) {
                    console.log(`   ⚠️ [${prop.name}] Tabela vazia para a data de hoje. Re-tentando mesma data (tentativa ${attempt + 1})...`);
                    await page.close();
                    continue;
                }
                console.log(`   🚫 Indisponível ou esgotado para a data de hoje (após ${MAX_RETRIES} tentativas)`);
                propUpdates.push({
                    property_id: prop.id,
                    property_name: prop.name,
                    room_name: 'Indisponível (Esgotado)',
                    price: 0,
                    source_url: currentUrl,
                    status: 'sold_out',
                });
            } else {
                console.log(`   📋 ${rooms.length} tipo(s) de quarto encontrado(s) (${nightsCount} noites):`);
                for (const room of rooms) {
                    const nightlyPrice = Math.round((room.price / nightsCount) * 100) / 100;
                    console.log(`      💵 ${room.name} (${room.adults} adultos, ${room.children} crianças): R$ ${nightlyPrice.toFixed(2)} /noite`);
                    propUpdates.push({
                        property_id: prop.id,
                        property_name: prop.name,
                        room_name: room.name,
                        price: nightlyPrice,
                        adults: room.adults,
                        children: room.children,
                        source_url: currentUrl,
                        status: 'available',
                        images: room.images || null,
                    });
                }
            }

            await page.close();
            const finalStatus = (rooms.length === 0) ? 'SOLD_OUT' : 'SUCCESS';
            return { status: finalStatus, updates: propUpdates, prop };

        } catch (err) {
            if (page) await page.close().catch(() => {});
            console.warn(`   ⚠️ [${prop.name}] Erro na tentativa ${attempt}: ${err.message}`);
            if (attempt < MAX_RETRIES) {
                await sleep(1500);
            }
        }
    }

    console.error(`   ❌ [${prop.name}] Falha após ${MAX_RETRIES} tentativas.`);
    return { status: 'TIMEOUT', updates: [], prop };
}

async function run() {
    const startTime = Date.now();
    const today = new Date();
    const checkin = new Date(today);
    const checkout = new Date(checkin);
    checkout.setDate(checkout.getDate() + 2); // Amplia a janela de busca para 2 diárias
    
    const checkinDate = formatDate(checkin);
    const checkoutDate = formatDate(checkout);

    console.log('\n══════════════════════════════════════════════════════════');
    console.log('   🤖 ROBÔ BOOKING-SCRAPER → LOVABLE (Janela de 2 Diárias)');
    console.log(`   📅 Check-in: ${checkinDate} | Check-out: ${checkoutDate} (2 noites)`);
    console.log(`   ⏰ ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);
    console.log('══════════════════════════════════════════════════════════\n');

    let properties = await fetchProperties();

    // Sanitização e limpeza automática de URLs com parâmetros antigos/expirados no Supabase
    const autoSanitizePropertyUrls = async (props) => {
        if (!supabaseAdmin) return;
        let count = 0;
        for (const prop of props) {
            if (!prop.source_url) continue;
            try {
                const rawObj = new URL(prop.source_url.trim());
                if (rawObj.search || rawObj.hash) {
                    const cleanCanonical = rawObj.origin + rawObj.pathname;
                    await supabaseAdmin.from('properties').update({ source_url: cleanCanonical }).eq('id', prop.id);
                    prop.source_url = cleanCanonical;
                    count++;
                }
            } catch (_) {}
        }
        if (count > 0) {
            console.log(`   🧹 [Auto-Sanitizador] ${count} URL(s) sanitizada(s) e limpa(s) no Supabase.`);
        }
    };

    await autoSanitizePropertyUrls(properties);

    const propFilterIdx = process.argv.indexOf('--property');
    if (propFilterIdx !== -1 && process.argv[propFilterIdx + 1]) {
        const filterVal = process.argv[propFilterIdx + 1].toLowerCase();
        properties = properties.filter(p => p.name.toLowerCase().includes(filterVal));
        console.log(`   🔍 Filtrando propriedades por: "${process.argv[propFilterIdx + 1]}" (restante: ${properties.length})`);
    }

    if (properties.length === 0) {
        console.log('⚠️  Nenhuma propriedade correspondente encontrada.');
        return;
    }

    console.log('🌐 Iniciando navegador Puppeteer (modo stealth otimizado)...');
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
    const checkedPropIds = [];
    const healthReport = [];

    // Processamento sequencial confiável (evita bloqueios de taxa de requisições paralelas na Booking)
    const CONCURRENCY = 1;
    console.log(`🚀 Processando ${properties.length} propriedades em sequência estável...\n`);

    for (let i = 0; i < properties.length; i += CONCURRENCY) {
        const chunk = properties.slice(i, i + CONCURRENCY);
        const batchResults = await Promise.all(
            chunk.map((prop, idx) => scrapePropertyWithRetry(browser, prop, i + idx, properties.length, checkinDate, checkoutDate))
        );

        for (const res of batchResults) {
            checkedPropIds.push(res.prop.id);
            healthReport.push({
                name: res.prop.name,
                status: res.status,
                updatesCount: res.updates.length
            });
            allUpdates.push(...res.updates);
        }

        if (i + CONCURRENCY < properties.length) {
            const pause = 2000 + Math.floor(Math.random() * 1500);
            await sleep(pause);
        }
    }

    await browser.close();

    const validUpdates = allUpdates.filter(update => {
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

        if (update.price === 35 || Math.abs(update.price - 35) < 0.01) {
            console.warn(`⚠️  Removendo atualização com valor anômalo de café da manhã (R$ 35,00):`, update.property_name, update.room_name);
            return false;
        }
        
        if (update.status === 'sold_out') {
            update.price = 0;
        }
        
        update.price = Math.round(update.price * 100) / 100;
        return true;
    });

    // Gravar preços e forçar atualização do timestamp updated_at no Supabase para TODAS as propriedades checadas
    await saveUpdates(validUpdates, checkedPropIds);

    const elapsedMs = Date.now() - startTime;
    const elapsedMinutes = Math.floor(elapsedMs / 60000);
    const elapsedSeconds = Math.round((elapsedMs % 60000) / 1000);

    const successCount = healthReport.filter(h => h.status === 'SUCCESS').length;
    const soldOutCount = healthReport.filter(h => h.status === 'SOLD_OUT').length;
    const timeoutCount = healthReport.filter(h => h.status === 'TIMEOUT' || h.status === 'INVALID_URL').length;

    console.log('\n══════════════════════════════════════════════════════════');
    console.log(`   ✅ SCRAPING FINALIZADO EM ${elapsedMinutes}min ${elapsedSeconds}s!`);
    console.log(`   📊 Propriedades Verificadas: ${properties.length}`);
    console.log(`      🟢 Sucesso com Preços: ${successCount}`);
    console.log(`      🚫 Esgotadas/Indisponíveis: ${soldOutCount}`);
    console.log(`      ⚠️  Falhas/Timeout: ${timeoutCount}`);
    console.log(`   📦 Entradas de quarto enviadas ao Supabase: ${validUpdates.length}`);
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

if (process.argv.includes('--once')) {
    run().catch(console.error);
} else {
    startLoop();
}

