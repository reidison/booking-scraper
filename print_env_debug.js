const url = process.env.SUPABASE_URL || '';
const cleanUrl = url.trim().replace(/^https?:\/\//, '').replace(/\.supabase\.co$/, '');

console.log('--- Identificando o ID do Projeto Supabase ---');
console.log('Comprimento total do ID:', cleanUrl.length);
if (cleanUrl.length >= 6) {
  console.log('Primeiras 3 letras:', cleanUrl.substring(0, 3));
  console.log('Últimas 3 letras:', cleanUrl.substring(cleanUrl.length - 3));
} else {
  console.log('ID bruto (muito curto):', cleanUrl);
}
