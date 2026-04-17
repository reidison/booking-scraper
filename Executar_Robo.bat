@echo off
title Robo Booking - Extraindo Dados
color 0A
echo =======================================================
echo          SISTEMA AUTOMATICO DE BUSCA BOOKING
echo =======================================================
echo.
echo Iniciando o robo invisivel...
echo Por favor, aguarde sem fechar esta janela.
echo O processo pode levar cerca de 30 a 60 segundos.
echo.

:: Executa o scraper usando o node
node scraper.js

echo.
echo =======================================================
echo CONCLUIDO! Abrindo o seu painel visual...
echo =======================================================
echo.

:: Abre o painel HTML automaticamente no navegador padrao
start index.html

:: Aguarda 3 segundos antes de fechar a janela preta
timeout /t 3 >nul
