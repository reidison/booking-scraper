/**
 * Daemon Resiliente do Robô Booking-Scraper
 * Executa ciclicamente o scraper a cada 30 minutos em segundo plano permanente.
 * Lida com autorrecuperação, erros de rede e registra logs de execução no Supabase.
 */

const { spawn } = require('child_process');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const INTERVAL_MINUTES = 30;
const INTERVAL_MS = INTERVAL_MINUTES * 60 * 1000;

const supabaseAdmin = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
    : null;

function formatLogTime() {
    return new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

async function runScraperOnce() {
    return new Promise((resolve) => {
        console.log(`\n==================================================`);
        console.log(`🚀 Daemon: Iniciando ciclo de scraping [${formatLogTime()}]`);
        console.log(`==================================================\n`);

        const scraperProcess = spawn('node', ['scraper.js', '--once'], {
            cwd: __dirname,
            stdio: 'inherit',
            shell: true
        });

        scraperProcess.on('close', (code) => {
            if (code === 0) {
                console.log(`\n✅ Daemon: Ciclo finalizado com SUCESSO às ${formatLogTime()}`);
            } else {
                console.error(`\n⚠️ Daemon: Ciclo finalizado com código de aviso/erro: ${code}`);
            }
            resolve(code);
        });

        scraperProcess.on('error', (err) => {
            console.error(`\n❌ Daemon: Erro ao disparar processo do scraper:`, err.message);
            resolve(1);
        });
    });
}

async function startLoop() {
    console.log(`\n🤖 DAEMON DO SCRAPER BOOKING INICIADO (Loop de ${INTERVAL_MINUTES} min)`);
    console.log(`📅 Hora atual: ${formatLogTime()}\n`);

    while (true) {
        try {
            await runScraperOnce();
        } catch (e) {
            console.error(`❌ Daemon: Exceção no ciclo:`, e.message);
        }

        console.log(`\n⏳ Próxima rodada programada em ${INTERVAL_MINUTES} minutos (${new Date(Date.now() + INTERVAL_MS).toLocaleTimeString('pt-BR')})...\n`);
        await new Promise(res => setTimeout(res, INTERVAL_MS));
    }
}

startLoop();
