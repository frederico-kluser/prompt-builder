// BENCHMARK DE VISÃO — família Bootstrap 5.3.3 (CSS oficial, vendorizado).
//
// Dois cenários com classes REAIS do Bootstrap: um painel administrativo denso
// (navbar, sidebar, tabela, paginação) e uma tela de login (formulário curto).
// Os controles interativos levam `data-vision-id`; a varredura do build falha
// se algum ficar sem anotação.

import type { SceneSpec } from '../scene-types.js';

const CSS = '../../vendor/bootstrap/bootstrap.min.css';

const doc = (title: string, body: string, extra = ''): string => `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>${title}</title>
<link rel="stylesheet" href="${CSS}">
<style>${extra}</style>
</head>
<body>${body}</body>
</html>`;

const painel: SceneSpec = {
  id: 'bootstrap-painel-cursos',
  family: 'bootstrap',
  title: 'Painel administrativo de cursos (Bootstrap 5)',
  theme: 'light',
  tags: ['dashboard', 'tabela', 'navbar'],
  html: doc(
    'EduLab — Cursos',
    `
<nav class="navbar bg-white border-bottom px-4" style="height:64px">
  <span class="navbar-brand fw-semibold text-primary">EduLab</span>
  <div class="ms-4" style="width:420px">
    <input class="form-control" data-vision-id="top-busca" placeholder="Buscar curso, aluno ou turma">
  </div>
  <div class="ms-auto d-flex gap-2">
    <button class="btn btn-light border" data-vision-id="top-notificacoes" data-vision-icon="sino de notificações" data-vision-aliases="sino|alertas"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1a4 4 0 0 0-4 4v3.3L2.7 10a.6.6 0 0 0 .5.9h9.6a.6.6 0 0 0 .5-.9L12 8.3V5a4 4 0 0 0-4-4Zm0 14a2 2 0 0 0 1.9-1.4H6.1A2 2 0 0 0 8 15Z"/></svg></button>
    <button class="btn btn-light border" data-vision-id="top-perfil" data-vision-aliases="perfil|minha conta">MP</button>
  </div>
</nav>
<div class="d-flex">
  <aside class="bg-white border-end p-3" style="width:240px;min-height:1016px">
    <ul class="nav flex-column gap-1">
      <li class="nav-item"><a class="nav-link active" href="#visao" data-vision-id="nav-visao-geral">Visão geral</a></li>
      <li class="nav-item"><a class="nav-link" href="#cursos" data-vision-id="nav-cursos">Cursos</a></li>
      <li class="nav-item"><a class="nav-link" href="#alunos" data-vision-id="nav-alunos">Alunos</a></li>
      <li class="nav-item"><a class="nav-link" href="#relatorios" data-vision-id="nav-relatorios">Relatórios</a></li>
    </ul>
  </aside>
  <main class="flex-grow-1 p-4">
    <div class="d-flex align-items-center justify-content-between mb-3">
      <div>
        <h1 class="h3 mb-1">Cursos</h1>
        <p class="text-secondary mb-0">3 cursos ativos neste semestre</p>
      </div>
      <button class="btn btn-primary px-3" data-vision-id="curso-novo" data-vision-aliases="adicionar curso|criar curso">Novo curso</button>
    </div>
    <div class="d-flex gap-2 mb-3">
      <input class="form-control" style="max-width:320px" data-vision-id="curso-filtro" placeholder="Filtrar por nome">
      <select class="form-select" style="max-width:200px" data-vision-id="curso-status" aria-label="Status">
        <option>Todos</option><option>Publicado</option><option>Rascunho</option><option>Arquivado</option>
      </select>
      <button class="btn btn-outline-secondary ms-auto" data-vision-id="curso-exportar">Exportar CSV</button>
    </div>
    <div class="card">
      <table class="table align-middle mb-0">
        <thead class="table-light"><tr>
          <th>Curso</th><th>Alunos</th><th>Status</th><th class="text-end">Ações</th>
        </tr></thead>
        <tbody>
          <tr>
            <td><strong>React Avançado</strong><div class="text-secondary small">8 módulos · 24 h</div></td>
            <td>128</td><td><span class="badge text-bg-success">Publicado</span></td>
            <td class="text-end">
              <button class="btn btn-sm btn-outline-primary" data-vision-id="editar-react-avancado" data-vision-aliases="editar curso react avancado">Editar</button>
              <button class="btn btn-sm btn-outline-danger" data-vision-id="excluir-react-avancado" data-vision-aliases="excluir curso react avancado">Excluir</button>
            </td>
          </tr>
          <tr>
            <td><strong>TypeScript na prática</strong><div class="text-secondary small">6 módulos · 18 h</div></td>
            <td>94</td><td><span class="badge text-bg-success">Publicado</span></td>
            <td class="text-end">
              <button class="btn btn-sm btn-outline-primary" data-vision-id="editar-typescript" data-vision-aliases="editar curso typescript">Editar</button>
              <button class="btn btn-sm btn-outline-danger" data-vision-id="excluir-typescript" data-vision-aliases="excluir curso typescript">Excluir</button>
            </td>
          </tr>
          <tr>
            <td><strong>Design de Interfaces</strong><div class="text-secondary small">5 módulos · 15 h</div></td>
            <td>61</td><td><span class="badge text-bg-warning">Rascunho</span></td>
            <td class="text-end">
              <button class="btn btn-sm btn-outline-primary" data-vision-id="editar-design" data-vision-aliases="editar curso design de interfaces">Editar</button>
              <button class="btn btn-sm btn-outline-danger" data-vision-id="excluir-design" data-vision-aliases="excluir curso design de interfaces">Excluir</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="d-flex align-items-center justify-content-between mt-3">
      <span class="text-secondary">Mostrando 1–3 de 12</span>
      <ul class="pagination mb-0">
        <li class="page-item disabled"><button class="page-link" data-vision-id="pagina-anterior" disabled>Anterior</button></li>
        <li class="page-item"><button class="page-link" data-vision-id="pagina-2">2</button></li>
        <li class="page-item"><button class="page-link" data-vision-id="pagina-proxima">Próxima</button></li>
      </ul>
    </div>
  </main>
</div>`,
    'body{background:#f4f6fa}',
  ),
  tasks: [
    { instruction: 'Clique em "Novo curso".', action: 'click', targetId: 'curso-novo', difficulty: 'easy' },
    {
      instruction: 'Clique em "Excluir" na linha do curso "TypeScript na prática".',
      action: 'click',
      targetId: 'excluir-typescript',
      difficulty: 'medium',
    },
    {
      instruction: 'Escolha o status "Rascunho" no filtro de status.',
      action: 'select',
      targetId: 'curso-status',
      text: 'Rascunho',
      difficulty: 'medium',
    },
    {
      instruction: 'Clique em "Editar" no curso "Design de Interfaces".',
      action: 'click',
      targetId: 'editar-design',
      difficulty: 'medium',
    },
  ],
};

const login: SceneSpec = {
  id: 'bootstrap-login',
  family: 'bootstrap',
  title: 'Tela de login (Bootstrap 5)',
  theme: 'light',
  tags: ['auth', 'formulário'],
  html: doc(
    'EduLab — Entrar',
    `
<div class="vh-100 d-flex align-items-center justify-content-center">
  <div class="card shadow-sm" style="width:440px">
    <div class="card-body p-4">
      <h1 class="h4 mb-1">EduLab</h1>
      <p class="text-secondary mb-4">Entre para continuar seus estudos</p>
      <form>
        <div class="mb-3">
          <label class="form-label" for="email">E-mail</label>
          <input class="form-control" id="email" type="email" data-vision-id="login-email" placeholder="voce@exemplo.com" data-vision-aliases="e-mail|email|correio eletrônico">
        </div>
        <div class="mb-3">
          <label class="form-label" for="senha">Senha</label>
          <input class="form-control" id="senha" type="password" data-vision-id="login-senha" placeholder="Sua senha" data-vision-aliases="password">
        </div>
        <div class="d-flex align-items-center justify-content-between mb-3">
          <div class="form-check">
            <input class="form-check-input" type="checkbox" id="lembrar" data-vision-id="login-lembrar" data-vision-aliases="lembrar de mim|manter conectado">
            <label class="form-check-label" for="lembrar">Lembrar-me</label>
          </div>
          <a href="#recuperar" data-vision-id="login-esqueci" class="small" data-vision-aliases="recuperar senha">Esqueci minha senha</a>
        </div>
        <button class="btn btn-primary w-100" data-vision-id="login-entrar" data-vision-aliases="entrar|acessar|login">Entrar</button>
        <button class="btn btn-outline-secondary w-100 mt-2" data-vision-id="login-criar-conta" data-vision-aliases="cadastrar|criar conta">Criar conta</button>
      </form>
      <p class="text-center text-secondary small mt-4 mb-0">
        Ao continuar você aceita os <a href="#termos" data-vision-id="login-termos">Termos de uso</a>.
      </p>
    </div>
  </div>
</div>`,
    'body{background:#eef2f8}',
  ),
  tasks: [
    { instruction: 'Digite "aluna@exemplo.com" no campo de e-mail.', action: 'type', targetId: 'login-email', text: 'aluna@exemplo.com', difficulty: 'easy' },
    { instruction: 'Clique no botão "Entrar".', action: 'click', targetId: 'login-entrar', difficulty: 'easy' },
    { instruction: 'Marque a caixa "Lembrar-me".', action: 'click', targetId: 'login-lembrar', difficulty: 'easy' },
    { instruction: 'Clique no link "Esqueci minha senha".', action: 'click', targetId: 'login-esqueci', difficulty: 'easy' },
  ],
};

export const BOOTSTRAP_SCENES: SceneSpec[] = [painel, login];
