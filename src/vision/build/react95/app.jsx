import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider, createGlobalStyle } from 'styled-components';
import original from 'react95/dist/themes/original';
import {
  Anchor, Button, Checkbox, Counter, Frame, GroupBox, MenuList, MenuListItem,
  ProgressBar, Radio, Select, Separator, Table, TableBody, TableDataCell, TableHead,
  TableHeadCell, TableRow, Tab, TabBody, Tabs, TextInput, Toolbar, Tooltip, Window,
  WindowContent, WindowHeader,
} from 'react95';

/* ------------------------------------------------------------------ helpers */

const Desktop = ({ children }) => (
  <div style={{
    position: 'fixed', inset: 0, background: original.desktopBackground,
    fontFamily: "'ms_sans_serif', 'MS Sans Serif', sans-serif", fontSize: 14,
    color: '#0a0a0a', overflow: 'hidden',
  }}>
    {children}
  </div>
);

const WindowButton = ({ label }) => (
  <Button size="sm" square aria-label={label} style={{ fontWeight: 700, lineHeight: 1 }}>
    {label}
  </Button>
);

const Row = ({ label, width = 92, children }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
    <span style={{ width, textAlign: 'right', flex: '0 0 auto' }}>{label}</span>
    <div style={{ flex: '1 1 auto', display: 'flex', alignItems: 'center', gap: 6 }}>{children}</div>
  </div>
);

const Icon = ({ d, size = 15, color = '#0a0a0a', fill = 'none' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke={color} strokeWidth="2"
       style={{ flex: '0 0 auto' }} aria-hidden="true">
    {d.map((p, i) => <path key={i} d={p} />)}
  </svg>
);

const IconBox = ({ bg, glyph, size = 34, color = '#fff' }) => (
  <div style={{
    width: size, height: size, background: bg, display: 'grid', placeItems: 'center',
    border: '1px solid rgba(0,0,0,.35)', color, fontSize: Math.round(size * 0.42), fontWeight: 700,
    flex: '0 0 auto', fontFamily: "'ms_sans_serif', sans-serif",
  }}>{glyph}</div>
);

const DesktopIcon = ({ label, bg, glyph }) => (
  <div style={{ textAlign: 'center', color: '#fff', width: 76 }}>
    <div style={{
      width: 36, height: 36, margin: '0 auto 4px', background: bg, border: '2px solid #fefefe',
      boxShadow: '2px 2px 0 rgba(0,0,0,.45)', display: 'grid', placeItems: 'center',
      fontSize: 17, fontWeight: 700,
    }}>{glyph}</div>
    <span style={{ fontSize: 12, display: 'block', lineHeight: 1.15, textShadow: '1px 1px 0 #000' }}>{label}</span>
  </div>
);

const GlobalVars = createGlobalStyle`
  html, body, #root { height: 100%; margin: 0; }
  body { background: ${(p) => p.theme.desktopBackground}; }
  * { box-sizing: border-box; }
  .pixelated, .pixelated * { -webkit-font-smoothing: none; }
`;

/* --------------------------------------------------------------------- data */

const pedidos = [
  { id: 'VC-10248', cliente: 'Atacadão do Sul LTDA', itens: 14, total: '18.420,00', status: 'Aprovado' },
  { id: 'VC-10247', cliente: 'Mercado Bom Preço', itens: 6, total: '4.190,50', status: 'Pendente' },
  { id: 'VC-10246', cliente: 'Distribuidora Nova Era', itens: 32, total: '51.905,00', status: 'Enviado' },
  { id: 'VC-10245', cliente: 'Casa & Cia Materiais', itens: 9, total: '7.312,80', status: 'Aprovado' },
  { id: 'VC-10244', cliente: 'Ferragens Guarani', itens: 21, total: '22.048,00', status: 'Cancelado' },
  { id: 'VC-10243', cliente: 'Supermercados Pampa', itens: 18, total: '16.274,30', status: 'Pendente' },
  { id: 'VC-10242', cliente: 'Transportes Litoral', itens: 4, total: '2.980,00', status: 'Enviado' },
  { id: 'VC-10241', cliente: 'Comercial Vale Verde', itens: 11, total: '9.860,00', status: 'Aprovado' },
];

/* ------------------------------------------------------------------- screen */

const App = () => {
  const [tab, setTab] = useState(0);
  const [cliente, setCliente] = useState('todos');

  return (
    <ThemeProvider theme={original}>
      <GlobalVars />
      <Desktop>
        {/* ------------------------------------------------- desktop icons */}
        <div className="pixelated" style={{ position: 'absolute', top: 10, left: 8, display: 'grid', gap: 18 }}>
          <DesktopIcon label="Meu computador" glyph="▣" bg="#0a6b6b" />
          <DesktopIcon label="Lixeira" glyph="▤" bg="#6b6b6b" />
          <DesktopIcon label="Planilhas" glyph="▦" bg="#0a5a0a" />
          <DesktopIcon label="Rede" glyph="◈" bg="#0a0a6b" />
        </div>

        {/* ------------------------------------------------- main window */}
        <Window style={{ position: 'absolute', top: 12, left: 96, width: 1150, height: 995 }} shadow>
          <WindowHeader style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <IconBox bg="#060084" glyph="VC" size={18} />
            <span style={{ fontWeight: 700, flex: '1 1 auto' }}>VendaCerta 95 — Pedidos</span>
            <WindowButton label="_" />
            <WindowButton label="□" />
            <WindowButton label="✕" />
          </WindowHeader>
          <WindowContent style={{ height: 'calc(100% - 40px)', padding: 5, display: 'flex', flexDirection: 'column', gap: 5 }}>
            {/* menu bar */}
            <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
              {['Arquivo', 'Editar', 'Ver', 'Pedidos', 'Ferramentas', 'Ajuda'].map((m) => (
                <Button key={m} variant="thin" size="sm">{m}</Button>
              ))}
              <div style={{ flex: '1 1 auto' }} />
              <Anchor href="#" onClick={(e) => e.preventDefault()} style={{ fontSize: 12 }}>
                Central de ajuda
              </Anchor>
            </div>
            <Separator size={2} />

            {/* toolbar */}
            <Toolbar style={{ gap: 4 }}>
              <Tooltip text="Criar novo pedido"><Button size="sm"><Icon d={['M12 5v14', 'M5 12h14']} /> Novo</Button></Tooltip>
              <Tooltip text="Salvar alterações"><Button size="sm"><Icon d={['M5 4h11l3 3v13H5z', 'M8 4v6h7V4']} /> Salvar</Button></Tooltip>
              <Tooltip text="Imprimir romaneio"><Button size="sm"><Icon d={['M7 8V4h10v4', 'M5 8h14v7H5z', 'M8 15h8v5H8z']} /> Imprimir</Button></Tooltip>
              <Separator orientation="vertical" size={26} />
              <Tooltip text="Enviar por e-mail"><Button size="sm"><Icon d={['M3 6h18v12H3z', 'M3 6l9 7 9-7']} /> Enviar</Button></Tooltip>
              <Button size="sm" disabled>Excluir</Button>
            </Toolbar>
            <Separator size={2} />

            {/* tabs */}
            <Tabs value={tab} onChange={(value) => setTab(value)}>
              <Tab value={0}><Icon d={['M4 6h16v13H4z', 'M8 6V4h8v2']} /> Pedidos</Tab>
              <Tab value={1}><Icon d={['M12 12a4 4 0 100-8 4 4 0 000 8', 'M4 21a8 8 0 0116 0']} /> Clientes</Tab>
              <Tab value={2}><Icon d={['M4 20V10', 'M10 20V4', 'M16 20v-7']} /> Relatórios</Tab>
              <Tab value={3}>Configurações</Tab>
            </Tabs>

            {/* filters */}
            <GroupBox label="Filtros de consulta" style={{ padding: '10px 8px 6px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 18px' }}>
                <Row label="Pedido"><TextInput placeholder="VC-10248" fullWidth /></Row>
                <Row label="Cliente">
                  <Select
                    value={cliente}
                    onChange={(opt) => setCliente(opt.value)}
                    options={[
                      { label: 'Todos os clientes', value: 'todos' },
                      { label: 'Atacadão do Sul LTDA', value: 'atacadao' },
                      { label: 'Mercado Bom Preço', value: 'bompreco' },
                      { label: 'Distribuidora Nova Era', value: 'novaera' },
                    ]}
                    width="100%"
                  />
                </Row>
                <Row label="De"><TextInput defaultValue="01/10/2026" fullWidth /></Row>
                <Row label="Até"><TextInput defaultValue="21/10/2026" fullWidth /></Row>
              </div>
              <Separator size={2} style={{ margin: '2px 0 8px' }} />
              <div style={{ display: 'flex', gap: 26, alignItems: 'flex-start' }}>
                <div>
                  <div style={{ marginBottom: 4, fontWeight: 700 }}>Canal de venda</div>
                  <Checkbox checked label="Loja online" />
                  <Checkbox checked label="Balcão" />
                  <Checkbox label="Telefone" />
                </div>
                <div>
                  <div style={{ marginBottom: 4, fontWeight: 700 }}>Ordenar por</div>
                  <Radio checked name="ordem" value="recente" label="Mais recentes" />
                  <Radio name="ordem" value="valor" label="Maior valor" />
                  <Radio name="ordem" value="prazo" label="Prazo de entrega" />
                </div>
                <div style={{ marginLeft: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <Button primary size="sm" style={{ minWidth: 108 }}>Filtrar</Button>
                  <Button size="sm" style={{ minWidth: 108 }}>Limpar</Button>
                  <Button size="sm" style={{ minWidth: 108 }}>Salvar como…</Button>
                </div>
              </div>
            </GroupBox>

            {/* table */}
            <TabBody style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', padding: 0 }}>
              <Table>
                <TableHead>
                  <TableRow>
                    <TableHeadCell style={{ width: 118 }}>Pedido</TableHeadCell>
                    <TableHeadCell>Cliente</TableHeadCell>
                    <TableHeadCell style={{ textAlign: 'right', width: 68 }}>Itens</TableHeadCell>
                    <TableHeadCell style={{ textAlign: 'right', width: 126 }}>Total (R$)</TableHeadCell>
                    <TableHeadCell style={{ width: 104 }}>Status</TableHeadCell>
                    <TableHeadCell style={{ width: 84 }}>Entrega</TableHeadCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {pedidos.map((p) => (
                    <TableRow key={p.id} style={{ cursor: 'default' }}>
                      <TableDataCell><Anchor href="#" onClick={(e) => e.preventDefault()}>{p.id}</Anchor></TableDataCell>
                      <TableDataCell>{p.cliente}</TableDataCell>
                      <TableDataCell style={{ textAlign: 'right' }}>{p.itens}</TableDataCell>
                      <TableDataCell style={{ textAlign: 'right' }}>{p.total}</TableDataCell>
                      <TableDataCell>{p.status}</TableDataCell>
                      <TableDataCell>{p.status === 'Cancelado' ? '—' : '23/10'}</TableDataCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <GroupBox label="Itens do pedido VC-10246" style={{ margin: '6px 4px 4px', padding: '10px 8px 6px' }}>
                <Table>
                  <TableHead>
                    <TableRow>
                      <TableHeadCell style={{ width: 110 }}>SKU</TableHeadCell>
                      <TableHeadCell>Produto</TableHeadCell>
                      <TableHeadCell style={{ textAlign: 'right', width: 80 }}>Qtd.</TableHeadCell>
                      <TableHeadCell style={{ textAlign: 'right', width: 120 }}>Unitário</TableHeadCell>
                      <TableHeadCell style={{ textAlign: 'right', width: 130 }}>Subtotal</TableHeadCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {[
                      ['SKU-8841', 'Cabo flexível 2,5 mm — rolo 100 m', 12, '1.180,00', '14.160,00'],
                      ['SKU-2210', 'Disjuntor tripolar 63 A', 8, '742,50', '5.940,00'],
                      ['SKU-1073', 'Quadro de distribuição 24 disj.', 6, '2.035,00', '12.210,00'],
                      ['SKU-6602', 'Canaleta PVC 40x20 — barra 3 m', 40, '34,90', '1.396,00'],
                    ].map(([sku, prod, qtd, unit, sub]) => (
                      <TableRow key={sku}>
                        <TableDataCell>{sku}</TableDataCell>
                        <TableDataCell>{prod}</TableDataCell>
                        <TableDataCell style={{ textAlign: 'right' }}>{qtd}</TableDataCell>
                        <TableDataCell style={{ textAlign: 'right' }}>{unit}</TableDataCell>
                        <TableDataCell style={{ textAlign: 'right' }}>{sub}</TableDataCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 24, padding: '6px 8px 2px', fontSize: 13 }}>
                  <span>Frete: <strong>R$ 1.280,00</strong></span>
                  <span>Impostos: <strong>R$ 6.919,00</strong></span>
                  <span>Total: <strong>R$ 51.905,00</strong></span>
                </div>
              </GroupBox>
            </TabBody>

            {/* status bar */}
            <Frame variant="status" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 6px', fontSize: 12 }}>
              <Frame variant="field" style={{ padding: '1px 6px' }}>8 de 128 pedidos</Frame>
              <Frame variant="field" style={{ padding: '1px 6px' }}>Total: R$ 132.990,60</Frame>
              <div style={{ flex: '1 1 auto' }} />
              <Frame variant="field" style={{ padding: '1px 6px' }}>CAPS</Frame>
              <Frame variant="field" style={{ padding: '1px 6px' }}>NUM</Frame>
              <Frame variant="field" style={{ padding: '1px 6px' }}>Sincronizado às 14:32</Frame>
            </Frame>
          </WindowContent>
        </Window>

        {/* ------------------------------------------------- summary window */}
        <Window style={{ position: 'absolute', top: 12, left: 1262, width: 638, height: 500 }} shadow>
          <WindowHeader style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <IconBox bg="#0a6b6b" glyph="Σ" size={18} />
            <span style={{ fontWeight: 700, flex: '1 1 auto' }}>Resumo do período</span>
            <WindowButton label="✕" />
          </WindowHeader>
          <WindowContent style={{ height: 'calc(100% - 40px)', padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <GroupBox label="Indicadores" style={{ padding: '10px 10px 8px' }}>
              {[['Receita do mês', 'R$ 1.284.930,00'], ['Pedidos pagos', '1.842'], ['Ticket médio', 'R$ 697,57']].map(([k, v]) => (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span>{k}</span><strong>{v}</strong>
                </div>
              ))}
              <Separator size={2} style={{ margin: '6px 0' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span>Meta do mês</span><span>78%</span>
              </div>
              <ProgressBar value={78} hideValue />
              <small style={{ display: 'block', marginTop: 6, color: '#333' }}>
                Faltam R$ 322.070,00 para a meta.
              </small>
            </GroupBox>

            <GroupBox label="Ações rápidas" style={{ padding: 2 }}>
              <MenuList fullWidth style={{ border: 0 }}>
                <MenuListItem style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-start' }}>
                  <Icon d={['M4 6h16v13H4z']} /> Abrir ordem de serviço
                </MenuListItem>
                <MenuListItem style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-start' }}>
                  <Icon d={['M12 3v12', 'M7 10l5 5 5-5', 'M4 21h16']} /> Exportar planilha
                </MenuListItem>
                <MenuListItem style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-start' }}>
                  <Icon d={['M5 8h14v9H5z', 'M8 8V5h8v3']} /> Gerar boleto
                </MenuListItem>
              </MenuList>
            </GroupBox>

            <Frame variant="field" style={{ padding: 8, flex: '1 1 auto' }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>Alertas do sistema</div>
              <div style={{ fontSize: 12, lineHeight: 1.5 }}>
                4 pedidos acima do SLA de 24h. 2 boletos vencem hoje.<br />
                Estoque crítico: 3 SKUs. Backup concluído às 03:00.
              </div>
            </Frame>
          </WindowContent>
        </Window>

        {/* ------------------------------------------------- dialog window */}
        <Window style={{ position: 'absolute', top: 528, left: 1262, width: 638, height: 474, zIndex: 20 }} shadow>
          <WindowHeader active style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ flex: '1 1 auto', fontWeight: 700 }}>Confirmar envio — VC-10246</span>
            <WindowButton label="✕" />
          </WindowHeader>
          <WindowContent style={{ height: 'calc(100% - 40px)', padding: 12, display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
              <div style={{
                width: 34, height: 34, borderRadius: '50%', background: '#060084', color: '#fefefe',
                display: 'grid', placeItems: 'center', fontWeight: 700, flex: '0 0 auto', fontSize: 18,
              }}>?</div>
              <div style={{ fontSize: 13, lineHeight: 1.45 }}>
                Confirmar o envio de <strong>VC-10246</strong> — Distribuidora Nova Era,
                32 itens, pela transportadora selecionada?
              </div>
            </div>
            <Row label="Transportadora" width={104}>
              <Select
                value="loggi"
                options={[
                  { label: 'Loggi — Expresso (1 dia útil)', value: 'loggi' },
                  { label: 'Total Express — Rodoviário', value: 'total' },
                  { label: 'Correios — PAC', value: 'pac' },
                ]}
                width="100%"
              />
            </Row>
            <Row label="Volumes" width={104}><TextInput defaultValue="4" style={{ width: 70 }} /></Row>
            <Row label="Nota fiscal" width={104}><TextInput defaultValue="3526 1021 0001 4800 0980" fullWidth /></Row>
            <Separator size={2} style={{ margin: '6px 0 10px' }} />
            <Checkbox checked label="Contratar seguro de carga (R$ 84,20)" />
            <Checkbox label="Enviar romaneio ao cliente por e-mail" />
            <div style={{ flex: '1 1 auto' }} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Button size="sm" style={{ minWidth: 104 }}>Cancelar</Button>
              <Button primary size="sm" style={{ minWidth: 136 }}>Confirmar envio</Button>
            </div>
          </WindowContent>
        </Window>

        {/* --------------------------------------------- open menu bar dropdown */}
        <div style={{ position: 'absolute', top: 46, left: 262, zIndex: 40, width: 258 }}>
          <MenuList fullWidth style={{ padding: 2, boxShadow: '2px 2px 0 rgba(0,0,0,.45)', position: 'relative' }}>
            <MenuListItem><span style={{ fontWeight: 700 }}>Novo pedido</span><span style={{ float: 'right', color: '#555' }}>Ctrl+N</span></MenuListItem>
            <MenuListItem>Abrir pedido existente…</MenuListItem>
            <MenuListItem>Duplicar pedido</MenuListItem>
            <Separator size={2} style={{ margin: '3px 0' }} />
            <MenuListItem>Exportar planilha</MenuListItem>
            <MenuListItem>Imprimir romaneio</MenuListItem>
            <Separator size={2} style={{ margin: '3px 0' }} />
            <MenuListItem>Fechar janela</MenuListItem>
          </MenuList>
        </div>

        {/* ------------------------------------------------- taskbar */}
        <Frame style={{
          position: 'absolute', bottom: 0, left: 0, right: 0, height: 44, zIndex: 50,
          display: 'flex', alignItems: 'center', gap: 4, padding: '3px 4px',
        }}>
          <Button primary active style={{ height: 34, minWidth: 88, fontWeight: 700 }}>
            <span style={{ marginRight: 6 }}>▣</span>Iniciar
          </Button>
          <Separator orientation="vertical" size={30} />
          <Button size="sm" active style={{ height: 34, minWidth: 214, justifyContent: 'flex-start' }}>
            <IconBox bg="#060084" glyph="VC" size={16} />
            <span style={{ marginLeft: 6, fontWeight: 700 }}>VendaCerta 95</span>
          </Button>
          <Button size="sm" style={{ height: 34, minWidth: 150, justifyContent: 'flex-start' }}>
            <IconBox bg="#0a6b6b" glyph="Σ" size={16} />
            <span style={{ marginLeft: 6 }}>Resumo</span>
          </Button>
          <Button size="sm" style={{ height: 34, minWidth: 132, justifyContent: 'flex-start' }}>Explorer</Button>
          <div style={{ flex: '1 1 auto' }} />
          <Frame variant="field" style={{ height: 30, display: 'flex', alignItems: 'center', gap: 14, padding: '0 10px', fontSize: 12 }}>
            <span>▮▮▮</span><span>⌨ PT-BR</span><span>14:32</span>
          </Frame>
        </Frame>
      </Desktop>
    </ThemeProvider>
  );
};

createRoot(document.getElementById('root')).render(<App />);
