// Aba Aplicativos: catálogo de programas essenciais. Cada cartão tem nome, descrição e o botão
// "Baixar aplicativo", que só abre a página oficial do desenvolvedor no navegador. Nada é baixado nem executado pelo JK Optimize.
import { useMemo, useState } from 'react'
import { AppWindow, Download, Search } from 'lucide-react'
import { APP_CATEGORIES, searchApps, type CatalogApp } from '@shared/constants/apps-catalog'
import { AppIcon, Button, Notice, PageHeader } from '../components/ui'
import { errorMessage } from '../services/api'
import { query } from '../services/ops'

export function AppsPage() {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const list = useMemo(() => searchApps(text), [text])

  const open = async (app: CatalogApp) => {
    setError(null)
    try {
      await query('apps.catalog.open', { id: app.id })
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <div data-page="apps">
      <div className="space-y-6">
        <PageHeader title="Aplicativos" description="Programas essenciais para quem acabou de formatar o PC. O botão abre a página oficial de download; você escolhe e conclui a instalação." icon={AppWindow} accent="optimize" />
        <label className="flex h-10 max-w-md items-center gap-2 rounded-control border border-line-strong bg-elevated px-3">
          <Search className="size-4 text-subtle" />
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Pesquisar aplicativo…" aria-label="Pesquisar aplicativo" className="w-full bg-transparent text-[13px] text-fg placeholder:text-subtle focus:outline-none" />
        </label>
        {error && <Notice tone="error">{error}</Notice>}
        {list.length === 0 && <p className="text-[13px] text-subtle">Nenhum aplicativo encontrado.</p>}
        {APP_CATEGORIES.map((cat) => {
          const items = list.filter((a) => a.category === cat)
          if (items.length === 0) return null
          return (
            <section key={cat} data-app-category={cat}>
              <h2 className="mb-3 text-[12px] font-semibold tracking-[0.12em] text-subtle uppercase">{cat}</h2>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {items.map((app) => (
                  <article key={app.id} data-app-card={app.id} className="flex flex-col rounded-card border border-line bg-surface p-5">
                    <div className="flex items-center gap-3">
                      <AppIcon id={app.id} name={app.name} />
                      <h3 className="text-[14px] font-semibold text-fg">{app.name}</h3>
                    </div>
                    <p className="mt-2 mb-4 line-clamp-3 flex-1 text-[12.5px] text-muted">{app.description}</p>
                    <Button variant="primary" icon={Download} onClick={() => void open(app)} data-download={app.id}>
                      Baixar aplicativo
                    </Button>
                  </article>
                ))}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
