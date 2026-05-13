const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const cors = require('cors');

const app = express();
const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

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

// Get all data
app.get('/api/data', (req, res) => {
    res.json(readData());
});

// Add a property
app.post('/api/properties', (req, res) => {
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
    res.json({ success: true, property: newProp });
});

// Delete a property
app.delete('/api/properties/:id', (req, res) => {
    const data = readData();
    const { id } = req.params;
    
    data.properties = data.properties.filter(p => p.id !== id);
    writeData(data);
    res.json({ success: true });
});

// Upload image
app.post('/api/upload/:id', upload.single('image'), (req, res) => {
    const id = req.params.id;
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    const data = readData();
    const propIndex = data.properties.findIndex(p => p.id === id);
    if (propIndex !== -1) {
        // Update URL to the new image
        data.properties[propIndex].main_photo_url = `imagens/${req.file.filename}?t=${Date.now()}`;
        writeData(data);
    }
    
    res.json({ success: true, imageUrl: `imagens/${req.file.filename}` });
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
