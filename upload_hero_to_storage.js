const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Erro: SUPABASE_URL ou SUPABASE_SERVICE_KEY ausente no .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function uploadHeroImage() {
  console.log('1. Lendo app_settings no Supabase...');
  const { data: row, error: fetchErr } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'layout_settings')
    .single();

  if (fetchErr || !row) {
    console.error('Erro ao ler layout_settings:', fetchErr?.message);
    return;
  }

  const settings = row.value || {};
  const b64Str = settings.heroImageUrl;

  if (!b64Str || !b64Str.startsWith('data:image')) {
    console.log('heroImageUrl já é uma URL ou está vazio:', b64Str ? b64Str.slice(0, 100) : 'vazio');
    return;
  }

  console.log(`2. Extraindo imagem em Base64 (tamanho: ${b64Str.length} caracteres)...`);
  const matches = b64Str.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
  if (!matches) {
    console.error('Formato Base64 inválido.');
    return;
  }

  const mimeType = matches[1];
  const base64Data = matches[2];
  const buffer = Buffer.from(base64Data, 'base64');
  console.log(`Buffer criado com sucesso: ${buffer.length} bytes (${(buffer.length / 1024).toFixed(1)} KB)`);

  const ext = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg';
  const fileName = `hero-banner-main.${ext}`;

  console.log(`3. Fazendo upload da imagem para o Supabase Storage (bucket: property-images / ${fileName})...`);
  const { data: uploadData, error: uploadErr } = await supabase.storage
    .from('property-images')
    .upload(fileName, buffer, {
      contentType: mimeType,
      upsert: true
    });

  if (uploadErr) {
    console.error('Erro no upload para o Storage:', uploadErr.message);
    return;
  }

  console.log('Upload concluído com sucesso!');

  console.log('4. Gerando URL pública...');
  const { data: publicUrlData } = supabase.storage.from('property-images').getPublicUrl(fileName);
  const publicUrl = publicUrlData.publicUrl;
  console.log(`URL pública gerada: ${publicUrl}`);

  console.log('5. Atualizando layout_settings em app_settings...');
  settings.heroImageUrl = publicUrl;
  const { error: updateErr } = await supabase
    .from('app_settings')
    .update({ value: settings })
    .eq('key', 'layout_settings');

  if (updateErr) {
    console.error('Erro ao atualizar banco:', updateErr.message);
    return;
  }

  console.log('\n======================================================');
  console.log('✅ SUCESSO! A imagem do Hero foi convertida e salva no Supabase Storage!');
  console.log(`URL pública configurada: ${publicUrl}`);
  console.log('======================================================');
}

uploadHeroImage().then(() => process.exit(0)).catch(e => {
  console.error('Erro inesperado:', e.message);
  process.exit(1);
});
