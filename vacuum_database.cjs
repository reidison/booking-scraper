const { Client } = require('pg');

const connectionString = 'postgresql://postgres.exgcaivlqfivhshfqwbc:%40Acessl17b1@aws-1-us-east-1.pooler.supabase.com:5432/postgres';

async function vacuum() {
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  try {
    console.log('Iniciando conexão com o banco de dados Supabase...');
    await client.connect();
    
    console.log('Executando VACUUM FULL no banco de dados para liberar espaço físico imediatamente...');
    // Executa o VACUUM FULL para otimizar e liberar espaço em disco
    await client.query('VACUUM FULL');
    
    console.log('VACUUM FULL concluído com sucesso! Espaço em disco liberado.');
  } catch (err) {
    console.error('Erro ao executar VACUUM:', err.message);
  } finally {
    await client.end();
  }
}

vacuum();
