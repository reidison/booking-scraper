const { createClient } = require('@supabase/supabase-js');

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
    const supabase = createClient(url, key);
    console.log('Testando query com supabase-js...');
    const { data, error } = await supabase.from('properties').select('id').limit(1);
    if (error) {
      console.log('Query retornou erro do Supabase:', error);
    } else {
      console.log('Query executada com sucesso! Data:', data);
    }
  } catch (err) {
    console.log('Ocorreu uma exceção no supabase-js:', err);
  }

  try {
    console.log('Testando fetch nativo do Node...');
    const headers = {
      'apikey': key,
      'Authorization': `Bearer ${key}`
    };
    const res = await fetch(`${url}/rest/v1/properties?select=id&limit=1`, { headers });
    console.log('Status do fetch nativo:', res.status);
    if (!res.ok) {
      const text = await res.text();
      console.log('Corpo da resposta de erro:', text);
    }
  } catch (err) {
    console.log('Erro no fetch nativo do Node:');
    console.log('Mensagem:', err.message);
    console.log('Stack:', err.stack);
    if (err.cause) {
      console.log('Causa (cause):', err.cause);
      if (err.cause.message) console.log('Causa - Mensagem:', err.cause.message);
      if (err.cause.stack) console.log('Causa - Stack:', err.cause.stack);
    }
  }
}

test();
