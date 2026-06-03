@echo off
title Robo Booking-Scraper → Lovable
color 0A
echo =======================================================
echo    ROBO BOOKING-SCRAPER → LOVABLE
echo    Le propriedades do Lovable e atualiza precos
echo    Atualiza a cada 15 minutos (configuravel no painel)
echo =======================================================
echo.

:: Inicia o robo
echo Iniciando robo de scraping...
echo.
echo  NAO FECHE esta janela! O robo roda continuamente.
echo  Pressione Ctrl+C para parar.
echo.

node scraper.js

:: Se o scraper parar por erro, reinicia automaticamente
:loop
echo.
echo =======================================================
echo O robo parou. Reiniciando em 10 segundos...
echo =======================================================
timeout /t 10 >nul
node scraper.js
goto loop
