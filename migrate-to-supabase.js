/**
 * Migração e Sincronização Completa: data.json → Supabase (via Direct write + Edge Function)
 * Cria propriedades no banco com metadados completos, faz upload de fotos locais para o Storage
 * e sincroniza os preços via Edge Function.
 * 
 * USO: node migrate-to-supabase.js
 */
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BOT_API_KEY = process.env.BOT_API_KEY || 'booking-scraper-2026';
const DATA_FILE = path.join(__dirname, 'data.json');

const supabaseAdmin = (SUPABASE_URL && SUPABASE_SERVICE_KEY)
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    : null;

function cleanBookingUrl(url) {
    if (!url || !url.includes('booking.com')) return null;
    try {
        let clean = url.replace(/^[^h]*https?/i, 'https');
        const u = new URL(clean);
        return `${u.origin}${u.pathname}`;
    } catch {
        return null;
    }
}

async function uploadLocalImage(localPath, destFilename) {
    if (!supabaseAdmin) return null;
    try {
        const fileBuffer = fs.readFileSync(localPath);
        let contentType = 'image/jpeg';
        if (destFilename.endsWith('.png')) contentType = 'image/png';
        else if (destFilename.endsWith('.webp')) contentType = 'image/webp';

        const { error } = await supabaseAdmin.storage
            .from('property-images')
            .upload(destFilename, fileBuffer, {
                contentType: contentType,
                upsert: true
            });

        if (error) {
            console.error(`   ❌ Falha ao subir imagem ${destFilename} para o Supabase Storage:`, error.message);
            return null;
        }

        const { data } = supabaseAdmin.storage
            .from('property-images')
            .getPublicUrl(destFilename);

        return data?.publicUrl || null;
    } catch (e) {
        console.error(`   ❌ Erro ao ler/enviar imagem local:`, e.message);
        return null;
    }
}

async function migrate() {
    console.log('══════════════════════════════════════════════════════════');
    console.log('   📦 MIGRAÇÃO COMPLETA: data.json → Supabase');
    console.log('══════════════════════════════════════════════════════════\n');

    if (!fs.existsSync(DATA_FILE)) {
        console.error('❌ data.json não encontrado!');
        return;
    }

    const dataObj = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    const localProps = dataObj.properties || [];
    console.log(`📋 ${localProps.length} propriedades no data.json\n`);

    if (!supabaseAdmin) {
        console.error('❌ SUPABASE_SERVICE_KEY não configurada no .env. Impossível realizar sincronização de metadados.');
        return;
    }

    // 1. Obter ou criar owner_id
    let ownerId = null;
    const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('user_id')
        .eq('email', 'reidisonlima@gmail.com')
        .single();

    if (profile) {
        ownerId = profile.user_id;
    } else {
        const { data: allProfiles } = await supabaseAdmin.from('profiles').select('user_id').limit(1);
        if (allProfiles && allProfiles.length > 0) {
            ownerId = allProfiles[0].user_id;
        }
    }

    console.log(`👤 Proprietário vinculado: ${ownerId ? 'OK' : 'NENHUM'}`);

    // Carrega propriedades existentes no Supabase para comparação
    const { data: dbProperties } = await supabaseAdmin
        .from('properties')
        .select('id, name, images, description, address, amenities, category, source_url');

    const dbPropByName = new Map();
    if (dbProperties) {
        dbProperties.forEach(p => {
            dbPropByName.set(p.name.trim().toLowerCase(), p);
        });
    }

    let localDataChanged = false;
    const updates = [];

    for (const local of localProps) {
        const name = local.property_name.trim();
        const sourceUrl = cleanBookingUrl(local.booking_link) || local.booking_link;

        if (!sourceUrl) {
            console.log(`⏩ Pulando "${name}" (URL inválida)`);
            continue;
        }

        // 2. Verificar se a propriedade existe no banco, se não existir, cria
        const nameKey = name.toLowerCase();
        let dbProp = dbPropByName.get(nameKey);

        if (!dbProp) {
            console.log(`🆕 Criando propriedade "${name}" no Supabase...`);
            const category = name.toLowerCase().startsWith('hotel') ? 'Hotel 3 estrelas' : 'Pousada';
            
            const { data: newProp, error: createErr } = await supabaseAdmin
                .from('properties')
                .insert({
                    owner_id: ownerId,
                    name: name,
                    category: category,
                    description: `Hospede-se no ${name} em Ouro Preto e desfrute de conforto e excelente localização histórica.`,
                    address: 'Centro Histórico, Ouro Preto - MG',
                    amenities: ['Wi-Fi', 'Café da manhã', 'Recepção 24h', 'Estacionamento'],
                    images: [],
                    status: 'approved',
                    source_url: sourceUrl,
                    price: 0,
                    rating: 4,
                    review_score: 8.5,
                    review_count: 120,
                    distance_from_center: 1.0
                })
                .select('*')
                .single();

            if (createErr) {
                console.error(`   ❌ Erro ao criar propriedade no banco:`, createErr.message);
                continue;
            }
            dbProp = newProp;
            dbPropByName.set(nameKey, dbProp);
            console.log(`   ✅ Criada com sucesso! ID: ${dbProp.id}`);
        }

        // 3. Verificar se a foto principal é local (ex: imagens/...) e enviá-la para o Storage
        let mainPhotoUrl = local.main_photo_url || '';
        const isLocalPhoto = mainPhotoUrl.startsWith('imagens/') || mainPhotoUrl.includes('localhost');

        if (isLocalPhoto) {
            // Extrai o caminho local limpo (sem query strings de tempo)
            const cleanLocalPath = mainPhotoUrl.split('?')[0];
            const fullLocalPath = path.join(__dirname, cleanLocalPath);

            if (fs.existsSync(fullLocalPath)) {
                console.log(`📸 Enviando foto de "${name}" para o Supabase Storage...`);
                const ext = path.extname(cleanLocalPath) || '.jpg';
                const destFilename = `${dbProp.id}${ext}`;
                const publicUrl = await uploadLocalImage(fullLocalPath, destFilename);

                if (publicUrl) {
                    mainPhotoUrl = publicUrl;
                    local.main_photo_url = publicUrl;
                    localDataChanged = true;
                    console.log(`   ✅ Enviada com sucesso! URL pública: ${publicUrl}`);
                }
            } else {
                console.log(`   ⚠️ Imagem local não encontrada em: ${fullLocalPath}`);
            }
        }

        // 4. Sincronizar imagens no banco de dados
        const dbImages = dbProp.images || [];
        const desiredImages = mainPhotoUrl ? [mainPhotoUrl] : [];

        // Se a propriedade no banco não possui imagens ou tem a imagem antiga local
        const hasDbLocalImages = dbImages.some(img => img.startsWith('imagens/') || img.includes('localhost'));
        
        if (dbImages.length === 0 || hasDbLocalImages || (mainPhotoUrl && dbImages[0] !== mainPhotoUrl)) {
            console.log(`🔄 Sincronizando metadados/imagens de "${name}" no Supabase...`);
            const { error: updateErr } = await supabaseAdmin
                .from('properties')
                .update({
                    images: desiredImages,
                    // Garante que campos de texto básicos não fiquem nulos
                    description: dbProp.description || `Hospede-se no ${name} em Ouro Preto e desfrute de conforto e excelente localização histórica.`,
                    address: dbProp.address || 'Centro Histórico, Ouro Preto - MG',
                    amenities: dbProp.amenities && dbProp.amenities.length > 0 ? dbProp.amenities : ['Wi-Fi', 'Café da manhã', 'Recepção 24h', 'Estacionamento'],
                    category: dbProp.category || (name.toLowerCase().startsWith('hotel') ? 'Hotel 3 estrelas' : 'Pousada')
                })
                .eq('id', dbProp.id);

            if (updateErr) {
                console.error(`   ❌ Erro ao atualizar metadados no Supabase:`, updateErr.message);
            } else {
                console.log(`   ✅ Metadados e imagens sincronizados com sucesso no banco!`);
            }
        }

        // 5. Preparar atualizações de preços
        let price = 0;
        let roomName = 'Quarto Padrão';

        if (local.room_types && local.room_types[0]) {
            const rt = local.room_types[0];
            roomName = rt.type || 'Quarto Padrão';
            if (rt.price && !rt.price.includes('--') && !rt.price.includes('indisponível')) {
                price = parseFloat(rt.price.replace(/R\$\s?/g, '').replace(/\./g, '').replace(/,/g, '.')) || 0;
            }
        }

        if (price > 0 && !roomName.includes('Aguardando') && !roomName.includes('Esgotado')) {
            updates.push({
                property_id: dbProp.id,
                property_name: name,
                room_name: roomName,
                price: price,
                source_url: sourceUrl,
                status: 'available',
            });
        }
    }

    // Gravar alterações de volta no data.json se URLs locais de fotos foram atualizadas para URLs do Supabase Storage
    if (localDataChanged) {
        console.log('💾 Salvando URLs públicas atualizadas no data.json local...');
        fs.writeFileSync(DATA_FILE, JSON.stringify(dataObj, null, 4));
        console.log('   ✅ data.json atualizado.');
    }

    // 6. Enviar atualizações de preços para o Supabase
    console.log(`\n📡 Enviando ${updates.length} atualizações de preços para o banco de dados...`);
    const url = `${SUPABASE_URL}/functions/v1/bot-update-prices`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_KEY}`,
            },
            body: JSON.stringify({ bot_key: BOT_API_KEY, updates }),
        });

        const result = await response.json();
        console.log('\n' + JSON.stringify(result, null, 2));

        if (result.success) {
            console.log(`\n✅ Sincronização e migração concluídas com sucesso! ${result.changes_count} preços alterados.`);
        } else {
            console.log(`\n❌ Erro na migração de preços: ${result.error}`);
        }
    } catch (error) {
        console.error(`❌ Erro de conexão com a Edge Function: ${error.message}`);
    }
}

migrate().then(() => process.exit(0));
