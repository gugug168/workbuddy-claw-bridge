Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
nodeExe = shell.ExpandEnvironmentStrings("%WB_NODE_EXE%")
If nodeExe = "%WB_NODE_EXE%" Or nodeExe = "" Then
  nodeExe = "node"
End If
shell.Run """" & nodeExe & """ """ & dir & "\server.mjs""", 0, False
