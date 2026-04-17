const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

const urls = [
    { name: 'Pousada do Mondego', id: 'mondego', url: 'https://www.booking.com/hotel/br/pousada-do-mondego.pt-br.html?checkin=2026-04-17&checkout=2026-04-18&group_adults=2&group_children=0' },
    { name: 'Hotel Recanto Da Serra (Recanto do Ouro)', id: 'recanto', url: 'https://www.booking.com/hotel/br/recanto-do-ouro-ouro-preto.pt-br.html?checkin=2026-04-17&checkout=2026-04-18&group_adults=2&group_children=0' }
];

async function run() {
    const imgDir = path.join(__dirname, 'imagens');
    if (!fs.existsSync(imgDir)){
        fs.mkdirSync(imgDir);
    }

    console.log('Iniciando o navegador invisível...');
    const browser = await puppeteer.launch({ headless: 'new' });
    
    let scrapedData = [];

    for (const item of urls) {
        console.log(`\nAcessando página: ${item.name}...`);
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        try {
            await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
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

                const extractImage = () => {
                    const img = document.querySelector('img.hide_bg_image_on_lazy_load, a.bh-photo-grid-item img, img.bh-photo-grid-item, .gallery-side-reviews-wrapper img, [data-testid="property-main-image"]');
                    if (img) return img.src || img.dataset.src || img.dataset.lazy;
                    return null;
                };

                return {
                    room_types: [{
                        type: extractRoomType(),
                        price: extractPrice()
                    }],
                    raw_img_url: extractImage()
                };
            });

            // Download da imagem físico
            let localImgPath = '';
            if (data.raw_img_url && !data.raw_img_url.startsWith('data:image')) {
                console.log(`Fazendo o download físico da imagem de ${item.name}...`);
                const viewSource = await page.goto(data.raw_img_url, { waitUntil: 'domcontentloaded' });
                const buffer = await viewSource.buffer();
                const fileName = `${item.id}.jpg`;
                fs.writeFileSync(path.join(imgDir, fileName), buffer);
                localImgPath = `imagens/${fileName}`;
                console.log('Imagem salva em: ' + localImgPath);
            } else {
                console.log(`Nenhuma imagem válida localizada para ${item.name}`);
            }

            scrapedData.push({
                property_name: item.name,
                booking_link: item.url,
                main_photo_url: localImgPath,
                room_types: data.room_types
            });

        } catch (error) {
            console.error(`Erro ao extrair ${item.name}: ${error.message}`);
            scrapedData.push({
                property_name: item.name,
                booking_link: item.url,
                main_photo_url: '',
                room_types: [{ type: 'Erro na extração', price: 'R$ --' }]
            });
        }


        
        await page.close();
    }

    await browser.close();

    console.log('\nGerando arquivo data.js para o painel...');
    const jsContent = `const scrapedData = ${JSON.stringify(scrapedData, null, 4)};`;
    fs.writeFileSync(path.join(__dirname, 'data.js'), jsContent);
    console.log('Scraping 100% Finalizado!');
}

run().catch(console.error);
