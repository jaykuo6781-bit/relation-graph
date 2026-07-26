<#
  放行手机访问所需的端口 —— 仅限 Tailscale 网段。

  为什么需要这一步:
    Windows 防火墙默认拦截入站连接。Tailscale 网卡通常被归到 Private
    配置文件,而 Python 安装时自动创建的放行规则往往只覆盖 Public,
    于是手机连过来会被静默拦掉 —— 表现为浏览器一直转圈或"无法连接",
    而电脑上 127.0.0.1 却完全正常。

  这条规则的范围:
    只放行 TCP 8787,且只接受来自 100.64.0.0/10(Tailscale 的地址段)
    的连接。局域网和公网都进不来。

  用法:右键「以管理员身份运行 PowerShell」,然后:
      cd 到本项目目录
      .\setup-firewall.ps1

  撤销:
      Remove-NetFirewallRule -DisplayName "relation-graph (Tailscale only)"
#>

param([int]$Port = 8787)

$isAdmin = ([Security.Principal.WindowsPrincipal]`
    [Security.Principal.WindowsIdentity]::GetCurrent()`
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host ""
    Write-Host "  需要管理员权限。" -ForegroundColor Yellow
    Write-Host "  请右键点「以管理员身份运行」打开 PowerShell,再执行本脚本。"
    Write-Host ""
    exit 1
}

$name = "relation-graph (Tailscale only)"

Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction SilentlyContinue

New-NetFirewallRule `
    -DisplayName $name `
    -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port `
    -RemoteAddress 100.64.0.0/10 -Profile Any `
    -Description "Allow tailnet peers to reach the relation-graph server" | Out-Null

Write-Host ""
Write-Host "  已放行 TCP $Port,仅限 Tailscale 网段(100.64.0.0/10)。" -ForegroundColor Green
Write-Host "  局域网和公网访问不受影响 —— 依然是拦截的。"
Write-Host ""
Write-Host "  撤销:Remove-NetFirewallRule -DisplayName `"$name`""
Write-Host ""
