const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

const today = new Date();
const tomorrow = new Date(today);
tomorrow.setDate(tomorrow.getDate() + 1);

const formatDate = (date) => {
    const d = date.getDate().toString().padStart(2, '0');
    const m = (date.getMonth() + 1).toString().padStart(2, '0');
    const y = date.getFullYear();
    return `${y}-${m}-${d}`;
};

const checkinDate = formatDate(today);
const checkoutDate = formatDate(tomorrow);

const DATA_FILE = path.join(__dirname, 'data.json');

function readData() {
    if (!fs.existsSync(DATA_FILE)) {
        return { scrapeInfo: {}, properties: [] };
    }
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
}

async function run() {
    const dataObj = readData();
    const urls = dataObj.properties || [];

    if (urls.length === 0) {
        console.log('Nenhum hotel cadastrado em data.json.');
        return;
    }

    console.log('Iniciando o navegador invisível...');
    const browser = await puppeteer.launch({ headless: 'new' });

    for (let i = 0; i < urls.length; i++) {
        const item = urls[i];
        console.log(`\nAcessando página: ${item.property_name}...`);
        
        // Build dynamic link
        const urlToScrape = new URL(item.booking_link);
        urlToScrape.searchParams.set('checkin', checkinDate);
        urlToScrape.searchParams.set('checkout', checkoutDate);
        urlToScrape.searchParams.set('group_adults', '2');
        urlToScrape.searchParams.set('group_children', '0');

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        try {
            await page.goto(urlToScrape.toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });
            await new Promise(r => setTimeout(r, 5000)); // Espera redirecionamentos do Booking
            
            console.log('Extraindo dados da tabela de disponibilidade...');
            const data = await page.evaluate(() => {
                const extractPrice = () => {
                    const priceEls = document.querySelectorAll('.prc-box-format__value, .bui-price-display__value, [data-testid="price-and-discounted-price"]');
                    for (let el of priceEls) {
                        if (el.innerText.includes('R$')) return el.innerText.trim();
                    }
                    const bodyText = document.body.innerText;
                    const match = bodyText.match(/R\$\s?[\d\.]+/);
                    return match ? match[0] : 'Preço indisponível';
                };

                const extractRoomType = () => {
                    const roomType = document.querySelector('.hprt-roomtype-link, .room-name, .hprt-roomtype-icon-link, [data-testid="room-type-name"]');
                    return roomType ? roomType.innerText.trim() : 'Quarto Padrão (2 Adultos)';
                };

                return {
                    room_types: [{
                        type: extractRoomType(),
                        price: extractPrice()
                    }]
                };
            });

            // Update property in array
            dataObj.properties[i].room_types = data.room_types;

        } catch (error) {
            console.error(`Erro ao extrair ${item.property_name}: ${error.message}`);
            dataObj.properties[i].room_types = [{ type: 'Erro na extração', price: 'R$ --' }];
        }


        
        await page.close();
    }

    await browser.close();

    dataObj.scrapeInfo = {
        date: new Date().toISOString(),
        checkin: checkinDate,
        checkout: checkoutDate
    };
    
    console.log('\nAtualizando arquivo data.json com os novos preços...');
    fs.writeFileSync(DATA_FILE, JSON.stringify(dataObj, null, 4));
    console.log('Scraping 100% Finalizado!');
}

run().catch(console.error);
