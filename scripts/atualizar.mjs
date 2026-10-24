// Atualiza direto o JK Optimize instalado neste computador:
//   1. sobe a versão (patch) no package.json;
//   2. gera o build e o instalador;
//   3. fecha o app se estiver aberto;
//   4. instala por cima em modo silencioso e reabre o app.
// Ativação, configurações e histórico ficam preservados (moram em %APPDATA%).
//
// Uso: npm.cmd run atualizar
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkgFile = join(root, 'package.json')
const APP_EXE = 'JK Optimize.exe'

function step(text) {
  console.log(`\n=== ${text}`)
}

function bumpPatch() {
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
  const [major, minor, patch] = pkg.version.split('.').map(Number)
  pkg.version = `${major}.${minor}.${patch + 1}`
  writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  return pkg.version
}

function removeOldReleases(keep) {
  const dir = join(root, 'release')
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    if (/^\d+\.\d+\.\d+$/.test(name) && name !== keep) rmSync(join(dir, name), { recursive: true, force: true })
  }
}

step('Nova versão')
const version = bumpPatch()
console.log(`Versão ${version}`)

step('Gerando build e instalador')
const build = spawnSync('npm.cmd run dist', { cwd: root, stdio: 'inherit', shell: true })
if (build.status !== 0) {
  console.error('\nFalha no build. Nada foi instalado.')
  process.exit(1)
}

const installer = join(root, 'release', version, `JK-Optimize-Setup-${version}.exe`)
if (!existsSync(installer)) {
  console.error(`\nInstalador não encontrado: ${installer}`)
  process.exit(1)
}
removeOldReleases(version)
publicarNoGitHub(version, installer)

// Manifesto assinado para o atualizador do app (opcional: precisa da senha do proprietário).
step('Manifesto de atualização assinado')
if (process.env.JKO_OWNER_PASSPHRASE) {
  const { decryptOwnerKey } = await import('../src/main/security/owner-key-file.ts')
  const { signManifest } = await import('../src/main/security/update-manifest.ts')
  const key = await decryptOwnerKey(readFileSync(join(root, 'owner-keys', 'owner-key.jkokey'), 'utf8'), process.env.JKO_OWNER_PASSPHRASE)
  const data = readFileSync(installer)
  const file = basename(installer)
  const manifest = signManifest(
    {
      format: 'jk-optimize-update',
      version,
      file,
      size: data.length,
      sha512: createHash('sha512').update(data).digest('base64'),
      releasedAt: new Date().toISOString(),
      notes: process.env.JKO_RELEASE_NOTES ?? ''
    },
    key
  )
  const updateDir = join(root, 'release', 'update')
  rmSync(updateDir, { recursive: true, force: true })
  mkdirSync(updateDir, { recursive: true })
  copyFileSync(installer, join(updateDir, file))
  writeFileSync(join(updateDir, 'jk-update.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  console.log(`Gerado em ${updateDir} (publique os dois arquivos juntos).`)
} else {
  console.log('Pulado: defina JKO_OWNER_PASSPHRASE para gerar o jk-update.json assinado.')
}

function publicarNoGitHub(version, installerPath) {
  step('Publicando no GitHub (pasta builds/)')
  try {
    const buildsDir = join(root, 'builds')
    mkdirSync(buildsDir, { recursive: true })
    const destName = `JK-Optimize-Setup-${version}.exe`
    copyFileSync(installerPath, join(buildsDir, destName))

    const run = (args) => spawnSync('git', args, { cwd: root, stdio: 'inherit' })
    run(['add', 'builds', 'package.json'])
    const commit = run(['commit', '-m', `build: v${version}\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`])
    if (commit.status !== 0) {
      console.log('Nada novo para commitar (ou falha no commit) — pulando push.')
      return
    }
    const push = run(['push', 'origin', 'HEAD:main'])
    if (push.status !== 0) {
      console.log('\nAviso: não consegui dar push automaticamente. Rode manualmente: git push origin HEAD:main')
    } else {
      console.log(`Build v${version} publicado em builds/${destName} no GitHub.`)
    }
  } catch (e) {
    console.log(`Aviso: publicação no GitHub falhou (${e.message}). O app foi atualizado normalmente mesmo assim.`)
  }
}

function isRunning() {
  const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${APP_EXE}`, '/NH'], { encoding: 'utf8' })
  return out.includes(APP_EXE)
}

step('Fechando o JK Optimize, se estiver aberto')
if (!isRunning()) {
  console.log('O app não estava aberto.')
} else {
  // Primeiro pede para fechar normalmente; força só se não fechar em ~5 s.
  try {
    execFileSync('taskkill', ['/IM', APP_EXE], { stdio: 'ignore' })
  } catch {}
  for (let i = 0; i < 10 && isRunning(); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
  if (isRunning()) {
    try {
      execFileSync('taskkill', ['/IM', APP_EXE, '/T', '/F'], { stdio: 'ignore' })
    } catch {}
  }
  console.log('App fechado.')
}

step('Instalando por cima (janela visível; aceite o aviso do Windows quando ele aparecer)')
const install = spawnSync(installer, ['--force-run'], { stdio: 'inherit' })
if (install.status !== 0) {
  console.error(`\nO instalador terminou com código ${install.status}.`)
  process.exit(1)
}
// Atualiza o cache de ícones do Windows para o atalho e a barra de tarefas mostrarem o ícone novo (não é crítico).
try {
  spawnSync('ie4uinit.exe', ['-show'], { stdio: 'ignore', timeout: 20_000 })
} catch {}
console.log(`\nJK Optimize atualizado para a versão ${version}. O app foi reaberto.`)
