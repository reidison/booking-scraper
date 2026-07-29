const { createClient } = require('@supabase/supabase-js');
const nodeFetch = require('node-fetch');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const cleanEnvVar = (val) => {
    if (!val) return val;
    let clean = val.trim();
    if ((clean.startsWith('"') && clean.endsWith('"')) || (clean.startsWith("'") && clean.endsWith("'"))) {
        clean = clean.substring(1, clean.length - 1).trim();
    }
    return clean;
};

const url = (() => {
    let u = cleanEnvVar(process.env.SUPABASE_URL);
    if (u && !u.startsWith('http')) {
        u = `https://${u}.supabase.co`;
    }
    return u;
})();
const key = cleanEnvVar(process.env.SUPABASE_KEY);

console.log(`URL: "${url}" (len: ${url ? url.length : 0})`);
console.log(`KEY: "${key}" (len: ${key ? key.length : 0})`);

async function test() {
  try {
    console.log('--- Testando supabase-js com node-fetch ---');
    const supabase = createClient(url, key, {
      global: { fetch: nodeFetch }
    });
    const { data, error } = await supabase.from('properties').select('id').limit(1);
    if (error) {
      console.log('Query com node-fetch retornou erro do Supabase:', error);
    } else {
      console.log('Query com node-fetch executada com SUCESSO! Data:', data);
    }
  } catch (err) {
    console.log('Ocorreu uma exceção no supabase-js com node-fetch:', err);
  }

  try {
    console.log('--- Testando node-fetch diretamente ---');
    const headers = {
      'apikey': key,
      'Authorization': `Bearer ${key}`
    };
    const res = await nodeFetch(`${url}/rest/v1/properties?select=id&limit=1`, { headers });
    console.log('Status do node-fetch:', res.status);
    if (!res.ok) {
      const text = await res.text();
      console.log('Corpo da resposta de erro:', text);
    } else {
      const json = await res.json();
      console.log('Resultado do node-fetch:', json);
    }
  } catch (err) {
    console.log('Erro no node-fetch diretamente:', err.message);
  }
}

test();
