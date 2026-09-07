# AGENTS.md

## Что это

`my-first-agent` — заготовка Node.js-проекта на TypeScript. Линтер и форматтер — Biome, тесты — Vitest, CI — GitHub Actions.

## Команды

```bash
npm install
npm run dev
npm run lint
npm run typecheck
npm test
npm run test:coverage
npm run build
```

Нужен Node.js 24+. Относительные импорты внутри проекта используют расширение `.ts`; сборка переписывает его в `.js`.

## Проверки

CI запускает `lint:ci`, `typecheck`, `test:coverage` и `build` на каждый pull request и push в `main`. Прекоммит-хук проверяет staged-файлы Biome и запускает проверку типов.
