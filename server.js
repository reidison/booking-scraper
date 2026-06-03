const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

// Carregar variáveis de ambiente do .env
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabaseAdmin = (SUPABASE_URL && SUPABASE_SERVICE_KEY)
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    : null;

if (supabaseAdmin) {
    console.log('✅ Supabase integrado com sucesso no Painel de Controle!');
} else {
    console.warn('⚠️ Supabase não configurado. As alterações locais não serão sincronizadas na nuvem.');
}

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Multer config for image uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, path.join(__dirname, 'imagens'));
    },
    filename: (req, file, cb) => {
        const id = req.params.id;
        const ext = path.extname(file.originalname) || '.jpg';
        cb(null, `${id}${ext}`);
    }
});
const upload = multer({ storage });

function readData() {
    if (!fs.existsSync(DATA_FILE)) {
        return { scrapeInfo: {}, properties: [] };
    }
    const content = fs.readFileSync(DATA_FILE, 'utf-8');
    return JSON.parse(content);
}

function writeData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 4));
}

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

// Get all data
app.get('/api/data', (req, res) => {
    res.json(readData());
});

// Add a property
app.post('/api/properties', async (req, res) => {
    const data = readData();
    const { property_name, booking_link } = req.body;
    
    if (!property_name || !booking_link) {
        return res.status(400).json({ error: 'Name and link are required' });
    }

    // Generate simple ID
    const id = property_name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now().toString().slice(-4);
    
    const newProp = {
        id,
        property_name,
        booking_link,
        main_photo_url: '',
        room_types: [{ type: 'Aguardando atualização', price: '--' }]
    };

    data.properties.push(newProp);
    writeData(data);

    // Sync to Supabase directly
    if (supabaseAdmin) {
        try {
            const cleanLink = cleanBookingUrl(booking_link) || booking_link;
            const category = property_name.toLowerCase().startsWith('hotel') ? 'Hotel 3 estrelas' : 'Pousada';
            
            // Check if already exists in Supabase
            const { data: exists } = await supabaseAdmin
                .from('properties')
                .select('id')
                .ilike('name', property_name.trim())
                .maybeSingle();
                
            if (!exists) {
                console.log(`➕ Criando nova propriedade no Supabase: ${property_name}`);
                
                // Get owner_id
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
                
                await supabaseAdmin.from('properties').insert({
                    owner_id: ownerId,
                    name: property_name.trim(),
                    category: category,
                    description: `Desfrute de excelente localização e muito conforto hospedando-se no ${property_name.trim()} em Ouro Preto.`,
                    address: 'Centro Histórico, Ouro Preto - MG',
                    amenities: ['Wi-Fi', 'Café da manhã', 'Recepção 24h', 'Estacionamento'],
                    images: [],
                    status: 'approved',
                    source_url: cleanLink,
                    price: 0,
                    rating: 4,
                    review_score: 8.5,
                    review_count: 120,
                    distance_from_center: 1.0
                });
            }
        } catch (err) {
            console.error('❌ Erro ao criar propriedade no Supabase:', err.message);
        }
    }

    res.json({ success: true, property: newProp });
});

// Delete a property
app.delete('/api/properties/:id', async (req, res) => {
    const data = readData();
    const { id } = req.params;
    
    const prop = data.properties.find(p => p.id === id);
    
    data.properties = data.properties.filter(p => p.id !== id);
    writeData(data);

    if (supabaseAdmin && prop) {
        try {
            console.log(`➖ Removendo propriedade no Supabase: ${prop.property_name}`);
            await supabaseAdmin
                .from('properties')
                .delete()
                .ilike('name', prop.property_name.trim());
        } catch (err) {
            console.error('❌ Erro ao remover propriedade no Supabase:', err.message);
        }
    }
    
    res.json({ success: true });
});

// Upload image
app.post('/api/upload/:id', upload.single('image'), async (req, res) => {
    const id = req.params.id;
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    const data = readData();
    const propIndex = data.properties.findIndex(p => p.id === id);
    let imageUrl = `imagens/${req.file.filename}`;
    
    if (propIndex !== -1) {
        const prop = data.properties[propIndex];
        // Save local path first as fallback
        prop.main_photo_url = `${imageUrl}?t=${Date.now()}`;
        writeData(data);
        
        // If Supabase is connected, upload it and update the database
        if (supabaseAdmin) {
            try {
                const propName = prop.property_name.trim();
                console.log(`📤 Enviando imagem para Supabase: ${propName}...`);
                
                // Find property in Supabase by name
                const { data: dbProp } = await supabaseAdmin
                    .from('properties')
                    .select('id, name')
                    .ilike('name', propName)
                    .single();
                    
                if (dbProp) {
                    const localPath = path.join(__dirname, 'imagens', req.file.filename);
                    const ext = path.extname(req.file.filename) || '.jpg';
                    const destFilename = `${dbProp.id}${ext}`;
                    
                    const fileBuffer = fs.readFileSync(localPath);
                    let contentType = 'image/jpeg';
                    if (destFilename.endsWith('.png')) contentType = 'image/png';
                    else if (destFilename.endsWith('.webp')) contentType = 'image/webp';
                    
                    const { error: uploadErr } = await supabaseAdmin.storage
                        .from('property-images')
                        .upload(destFilename, fileBuffer, {
                            contentType: contentType,
                            upsert: true
                        });
                        
                    if (!uploadErr) {
                        const { data: urlData } = supabaseAdmin.storage
                            .from('property-images')
                            .getPublicUrl(destFilename);
                            
                        if (urlData && urlData.publicUrl) {
                            const publicUrl = urlData.publicUrl;
                            console.log(`✅ Imagem enviada ao Supabase Storage: ${publicUrl}`);
                            
                            // Update property in Supabase
                            await supabaseAdmin
                                .from('properties')
                                .update({
                                    images: [publicUrl]
                                })
                                .eq('id', dbProp.id);
                                
                            // Update main_photo_url in data.json to public URL
                            prop.main_photo_url = publicUrl;
                            writeData(data);
                            imageUrl = publicUrl;
                        }
                    } else {
                        console.error('❌ Erro no upload do Supabase Storage:', uploadErr.message);
                    }
                } else {
                    console.log(`⚠️ Propriedade "${propName}" não encontrada no Supabase.`);
                }
            } catch (err) {
                console.error('❌ Erro durante o upload/sincronização no Supabase:', err.message);
            }
        }
    }
    
    res.json({ success: true, imageUrl });
});

// Trigger Scraper
app.post('/api/scrape', (req, res) => {
    // Spawn the scraper process asynchronously
    const scraper = spawn('node', ['scraper.js'], { detached: true, stdio: 'ignore' });
    scraper.unref();
    res.json({ success: true, message: 'Scraping started in background' });
});

app.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(`PAINEL ATIVO! Abra http://localhost:${PORT} no seu navegador`);
    console.log(`=======================================================`);
});
