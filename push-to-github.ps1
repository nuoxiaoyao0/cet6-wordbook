# 一键推到 GitHub（双击运行，或在 PowerShell 里执行）
# 用法： .\push-to-github.ps1                 # 默认推到 WilsonHuangDev/cet6-wordbook
#        .\push-to-github.ps1 -Repo 别的仓库名
param(
  [string]$User = "WilsonHuangDev",
  [string]$Repo = "cet6-wordbook"
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "== 目标仓库: https://github.com/$User/$Repo" -ForegroundColor Cyan
Write-Host "   前提：这个仓库已经在 GitHub 网页上创建好（空仓库，不要勾 README）" -ForegroundColor DarkGray

$url = "https://github.com/$User/$Repo.git"
git remote remove origin 2>$null
git remote add origin $url
git branch -M main

Write-Host ""
Write-Host "== 开始推送（会要求输入 GitHub 用户名和 Personal Access Token）" -ForegroundColor Cyan
Write-Host "   用户名：$User" -ForegroundColor Yellow
Write-Host "   密码不是账号密码，要去 https://github.com/settings/tokens 生成一个 classic token（勾 repo）" -ForegroundColor Yellow
Write-Host ""

git push -u origin main

if ($LASTEXITCODE -eq 0) {
  Write-Host ""
  Write-Host "== 推送成功。" -ForegroundColor Green
  Write-Host "下一步：仓库 Settings -> Pages -> Source 选 Deploy from a branch,"
  Write-Host "        Branch = main, 目录 = / (root), 然后 Save。"
  Write-Host "约 1 分钟后可访问: https://$User.github.io/$Repo/"
} else {
  Write-Host ""
  Write-Host "== 推送失败，见上面的报错。" -ForegroundColor Red
}
