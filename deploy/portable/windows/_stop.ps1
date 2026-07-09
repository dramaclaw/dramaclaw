# DramaClaw portable - stop helper: terminate python processes belonging to THIS package only
$root = (Split-Path -Parent $MyInvocation.MyCommand.Path).TrimEnd('\')
$procs = Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
  Where-Object { $_.ExecutablePath -like "$root\runtime\python\*" }
if ($procs) {
  $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Write-Host ("DramaClaw stopped: " + @($procs).Count + " process(es).")
} else {
  Write-Host "DramaClaw is not running."
}
