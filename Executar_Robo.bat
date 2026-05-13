@echo off
title Painel Booking - Servidor Local
color 0A
echo =======================================================
echo          SISTEMA AUTOMATICO DE BUSCA BOOKING
echo =======================================================
echo.
echo Iniciando o Servidor Local...
echo Por favor, NAO FECHE esta janela enquanto estiver usando o painel.
echo.

:: Inicia o servidor Node em segundo plano e aguarda 2 segundos
start /B node server.js
timeout /t 2 >nul

echo.
echo =======================================================
echo ABRINDO PAINEL NO NAVEGADOR...
echo =======================================================
echo.

:: Abre o painel HTML automaticamente no navegador padrao
start http://localhost:3000

:: Mantem a janela aberta
cmd /k
