' DSH Desk silent launcher - ASCII only, zero console window
Dim fso, sh, folder
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run """" & folder & "\node_modules\electron\dist\electron.exe"" """ & folder & """", 0, False
