const dns = require('dns');

const hostname = 'exgcaivlqfivhshfqwbc.supabase.co';

console.log(`Diagnosticando DNS para: ${hostname}`);

// 1. dns.lookup padrão
dns.lookup(hostname, (err, address, family) => {
  if (err) {
    console.log('1. dns.lookup (padrão) FALHOU:', err.message);
  } else {
    console.log('1. dns.lookup (padrão) SUCESSO:', address, `(IPv${family})`);
  }
});

// 2. dns.lookup forçando IPv4
dns.lookup(hostname, { family: 4 }, (err, address, family) => {
  if (err) {
    console.log('2. dns.lookup (family: 4) FALHOU:', err.message);
  } else {
    console.log('2. dns.lookup (family: 4) SUCESSO:', address, `(IPv${family})`);
  }
});

// 3. dns.lookup forçando IPv6
dns.lookup(hostname, { family: 6 }, (err, address, family) => {
  if (err) {
    console.log('3. dns.lookup (family: 6) FALHOU:', err.message);
  } else {
    console.log('3. dns.lookup (family: 6) SUCESSO:', address, `(IPv${family})`);
  }
});

// 4. dns.resolve4 (resolução direta IPv4)
dns.resolve4(hostname, (err, addresses) => {
  if (err) {
    console.log('4. dns.resolve4 FALHOU:', err.message);
  } else {
    console.log('4. dns.resolve4 SUCESSO:', addresses);
  }
});

// 5. dns.resolve6 (resolução direta IPv6)
dns.resolve6(hostname, (err, addresses) => {
  if (err) {
    console.log('5. dns.resolve6 FALHOU:', err.message);
  } else {
    console.log('5. dns.resolve6 SUCESSO:', addresses);
  }
});
