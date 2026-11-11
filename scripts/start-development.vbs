Option Explicit
Dim shell, files, project, node, script, command, exitCode
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
project = files.GetParentFolderName(files.GetParentFolderName(WScript.ScriptFullName))
node = files.BuildPath(shell.ExpandEnvironmentStrings("%ProgramFiles%"), "nodejs\node.exe")
If Not files.FileExists(node) Then node = "node.exe"
script = files.BuildPath(project, "scripts\dev.mjs")
shell.CurrentDirectory = project
command = Chr(34) & node & Chr(34) & " " & Chr(34) & script & Chr(34) & " --once"
On Error Resume Next
exitCode = shell.Run(command, 0, True)
If Err.Number <> 0 Then exitCode = 1
On Error GoTo 0
If exitCode <> 0 Then
  MsgBox "Development startup failed. Install Node.js and the project dependencies, then run node scripts/dev.mjs --once for details.", 16, "Twitch Downloader"
End If
WScript.Quit exitCode
