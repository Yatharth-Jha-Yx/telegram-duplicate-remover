# Connects the deployed Worker to your Telegram bot.
#   .\setup-bot.ps1 -Url https://telegram-dedupe-bot.<your-subdomain>.workers.dev
# (wrangler deploy prints this URL.)
# NOTE: a Telegram bot has only one webhook. Using a bot token that another
# Worker or server already uses would move that bot over to this Worker.
# 1. Asks wrangler for your bot token (typed by you, stored only as a Cloudflare secret).
# 2. Generates a random webhook secret and stores it as a Cloudflare secret.
# 3. Tells Telegram to send the group's messages to the Worker.
# Safe to run again, for example after you change the bot token.

param(
    [Parameter(Mandatory = $true)][string]$Url,
    [string]$Worker = "telegram-dedupe-bot"
)
$url = $Url.TrimEnd("/")
$worker = $Worker

# Some antivirus HTTPS scanning (AVG/Avast) re-signs traffic with its own certificate,
# which makes wrangler fail with "fetch failed". Tell Node to trust it, for this script only.
$avgCert = "C:\ProgramData\AVG\Antivirus\wscert.pem"
if (-not $env:NODE_EXTRA_CA_CERTS -and (Test-Path -LiteralPath $avgCert)) { $env:NODE_EXTRA_CA_CERTS = $avgCert }

Write-Host "Paste your NEW bot token from @BotFather when wrangler asks for the secret value." -ForegroundColor Cyan
npx.cmd wrangler secret put BOT_TOKEN --name $worker
if ($LASTEXITCODE -ne 0) { Write-Host "Setting BOT_TOKEN failed." -ForegroundColor Red; exit 1 }

$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$secret = -join ($bytes | ForEach-Object { $_.ToString("x2") })
$secret | npx.cmd wrangler secret put WEBHOOK_SECRET --name $worker
if ($LASTEXITCODE -ne 0) { Write-Host "Setting WEBHOOK_SECRET failed." -ForegroundColor Red; exit 1 }

# New secrets take a few seconds to reach the Worker.
$result = $null
for ($i = 1; $i -le 6 -and -not $result; $i++) {
    Start-Sleep -Seconds 5
    try {
        $result = Invoke-RestMethod -Method Post -Uri "$url/setup" -Headers @{ "X-Setup-Key" = $secret }
    } catch {
        Write-Host "  waiting for the new secret to go live ($i/6)..."
    }
}

if ($result -and $result.ok) {
    Write-Host "Webhook registered." -ForegroundColor Green
    Write-Host "Now add the bot to your group as an admin with the 'Delete messages' right."
} elseif ($result) {
    Write-Host "Telegram refused: $($result.description)" -ForegroundColor Red
    Write-Host "If it says Unauthorized, the bot token is wrong. Run this script again."
} else {
    Write-Host "Could not reach the Worker's setup step. Run this script again in a minute." -ForegroundColor Red
}
