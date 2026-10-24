import { GateLayout } from '../../layouts/GateLayout'
import { Card, Notice, Wordmark } from '../../components/ui'

export function SetupRequired({ isPackaged }: { isPackaged: boolean }) {
  return (
    <GateLayout>
      <div className="mb-6 flex justify-center">
        <Wordmark size="lg" />
      </div>
      <Card title="Configuração inicial do proprietário">
        {isPackaged ? (
          <Notice tone="warn" title="Licenciamento não configurado">
            Este instalador foi gerado sem a chave pública de licenciamento e não pode ser ativado. Entre em contato com o
            proprietário do JK Optimize.
          </Notice>
        ) : (
          <div className="space-y-4 text-[13px] text-muted">
            <p>
              Este build ainda não tem uma identidade de proprietário. Ela é criada uma única vez, fora do aplicativo, para que
              ninguém se torne administrador apenas por abrir o programa.
            </p>
            <ol className="list-decimal space-y-2 pl-5">
              <li>
                Feche o aplicativo e, na pasta do projeto, execute:
                <code className="selectable mt-1.5 block rounded-control border border-line bg-elevated px-3 py-2 font-mono text-[12px] text-fg">
                  npm run owner:init
                </code>
              </li>
              <li>Defina uma senha forte. O comando cria o arquivo cifrado da chave do proprietário (.jkokey).</li>
              <li>Abra o aplicativo novamente e escolha "Sou o proprietário" para importar esse arquivo.</li>
            </ol>
            <Notice tone="info">Guarde o arquivo .jkokey e a senha em local seguro. Sem eles não é possível emitir chaves.</Notice>
          </div>
        )}
      </Card>
    </GateLayout>
  )
}
