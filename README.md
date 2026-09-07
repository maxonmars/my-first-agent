# my-first-agent

Бойлерплейт Node.js-проекта на TypeScript: Biome, Vitest, проверка покрытия, Git-хуки и CI в GitHub Actions.

## Требования

- Node.js 24+
- npm

## Команды

```bash
npm install
npm run dev
npm run lint
npm run typecheck
npm test
npm run test:coverage
npm run build
npm start
```

`npm install` подключает `.githooks/pre-commit`. Перед коммитом запускаются Biome для staged-файлов и проверка типов. CI выполняет линтер, проверку типов, тесты с покрытием и сборку.
