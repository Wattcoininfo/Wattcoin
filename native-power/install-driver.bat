@echo off
sc create ScaphandreDrv type= kernel start= demand binPath= "C:\Users\taavi\Desktop\Erinevad projektid\Wattcoin\native-power\driver\ScaphandreDrv.sys"
sc start ScaphandreDrv
sc query ScaphandreDrv > "C:\Users\taavi\Desktop\Erinevad projektid\Wattcoin\native-power\driver\result.txt" 2>&1
