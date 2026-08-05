@echo off
title Otimizar Banco de Dados (VACUUM FULL)
color 0B
echo =======================================================
echo    OTIMIZAR BANCO DE DADOS (VACUUM FULL)
echo    Otimiza as tabelas e libera espaco em disco no Supabase.
echo =======================================================
echo.
echo Executando o script de otimizacao...
echo.
node "%~dp0\vacuum_database.cjs"
echo.
echo =======================================================
echo Processo concluido!
echo =======================================================
pause
