// Benchmark reproduzível e moderado (não é teste de estresse). Executa dentro do
// processo do executor. Cargas fixas e determinísticas:
//   - CPU 1 thread: SHA-256 de 256 MB (4 × bloco de 64 MB);
//   - CPU multi-thread: o mesmo trabalho por thread, uma thread por processador lógico;
//   - Memória: cópia de um buffer de 256 MB, 8 vezes;
//   - Disco: gravação sequencial de 256 MB (com fsync) e leitura do mesmo arquivo.
import { createHash } from 'node:crypto'
import { closeSync, fsyncSync, openSync, readSync, rmSync, writeSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

const MB = 1024 * 1024
const BLOCK_MB = 64

export function deterministicBlock(sizeMb = BLOCK_MB): Buffer {
  const buf = Buffer.allocUnsafe(sizeMb * MB)
  let x = 0x9e3779b9
  for (let i = 0; i < buf.length; i += 4) {
    x = (x ^ (x << 13)) >>> 0
    x = (x ^ (x >>> 17)) >>> 0
    x = (x ^ (x << 5)) >>> 0
    buf.writeUInt32LE(x, i)
  }
  return buf
}

function hashRounds(block: Buffer, rounds: number): number {
  const t0 = performance.now()
  for (let r = 0; r < rounds; r++) createHash('sha256').update(block).digest()
  return performance.now() - t0
}

const WORKER_CODE = `
const { parentPort, workerData } = require('node:worker_threads')
const { createHash } = require('node:crypto')
const buf = Buffer.alloc(workerData.mb * 1024 * 1024, 7)
const t0 = performance.now()
for (let r = 0; r < workerData.rounds; r++) createHash('sha256').update(buf).digest()
parentPort.postMessage(performance.now() - t0)`

async function multiThread(threads: number, rounds: number): Promise<number> {
  const t0 = performance.now()
  await Promise.all(
    Array.from(
      { length: threads },
      () =>
        new Promise<number>((resolve, reject) => {
          const w = new Worker(WORKER_CODE, { eval: true, workerData: { mb: BLOCK_MB, rounds } })
          w.once('message', resolve)
          w.once('error', reject)
        })
    )
  )
  return performance.now() - t0
}

export interface BenchmarkMetrics {
  cpuSingleMBps: number
  cpuMultiMBps: number | null
  memoryCopyGBps: number
  diskWriteMBps: number | null
  diskReadMBps: number | null
  threads: number
  durationMs: number
  notes: string[]
}

export async function runBenchmark(includeDisk: boolean): Promise<BenchmarkMetrics> {
  const started = performance.now()
  const notes: string[] = []
  const block = deterministicBlock()
  hashRounds(block, 1) // aquecimento
  const singleMs = hashRounds(block, 4)
  const cpuSingleMBps = (4 * BLOCK_MB * 1000) / singleMs

  const threads = os.cpus().length
  let cpuMultiMBps: number | null = null
  try {
    const multiMs = await multiThread(threads, 2)
    cpuMultiMBps = (threads * 2 * BLOCK_MB * 1000) / multiMs
  } catch (error) {
    notes.push(`CPU multi-thread indisponível: ${(error as Error).message}`)
  }

  const src = Buffer.concat([block, block, block, block])
  const dst = Buffer.allocUnsafe(src.length)
  src.copy(dst) // aquecimento
  const memT0 = performance.now()
  for (let i = 0; i < 8; i++) src.copy(dst)
  const memoryCopyGBps = (8 * src.length) / MB / 1024 / ((performance.now() - memT0) / 1000)

  let diskWriteMBps: number | null = null
  let diskReadMBps: number | null = null
  if (includeDisk) {
    const file = join(os.tmpdir(), `jko-bench-${process.pid}.bin`)
    try {
      const chunk = block.subarray(0, 4 * MB)
      const fd = openSync(file, 'w')
      const w0 = performance.now()
      for (let i = 0; i < 64; i++) writeSync(fd, chunk)
      fsyncSync(fd)
      diskWriteMBps = 256 / ((performance.now() - w0) / 1000)
      closeSync(fd)
      const rfd = openSync(file, 'r')
      const rbuf = Buffer.allocUnsafe(4 * MB)
      const r0 = performance.now()
      while (readSync(rfd, rbuf, 0, rbuf.length, null) > 0) {
        /* leitura sequencial */
      }
      diskReadMBps = 256 / ((performance.now() - r0) / 1000)
      closeSync(rfd)
      notes.push('A leitura de disco pode vir do cache do Windows logo após a gravação; compare apenas execuções equivalentes.')
    } catch (error) {
      notes.push(`Teste de disco falhou: ${(error as Error).message}`)
    } finally {
      rmSync(file, { force: true })
    }
  }
  const round = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10)
  return {
    cpuSingleMBps: round(cpuSingleMBps)!,
    cpuMultiMBps: round(cpuMultiMBps),
    memoryCopyGBps: round(memoryCopyGBps)!,
    diskWriteMBps: round(diskWriteMBps),
    diskReadMBps: round(diskReadMBps),
    threads,
    durationMs: Math.round(performance.now() - started),
    notes
  }
}
