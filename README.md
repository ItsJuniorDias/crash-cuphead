# Biplane Bonanza

Jogo de crash (iGaming) com estética de desenho animado dos anos 30, feito com Three.js + Vite.

## Rodar

```bash
npm install
npm run dev
```

## Gerar a arte (OpenRouter + Nano Banana / Gemini 2.5 Flash Image)

```bash
cp .env.example .env            # coloque sua OPENROUTER_API_KEY
npm run assets:all              # gera tudo: avião primeiro, o resto com ele como referência de estilo
```

- Saída: PNGs com fundo transparente em `public/assets/` + `manifest.json` (o jogo carrega sozinho) e uma folha de prévia em `art/preview.png`.
- O modelo não gera alfa: o script pede fundo magenta e remove com `sharp`. Originais ficam em `art/raw/` (`--rekey` reprocessa sem custo).
- Veio virado para o lado errado? `npm run assets -- plane --rekey --flop`.
- Não gostou de um asset? `npm run assets -- hills --force` regera só ele.
- **Hélice animada:** o avião é gerado sem hélice e `propeller` é gerada à parte; o script cria 8 quadros (`propeller_0..7.png`, meia volta com cubo redondo) e detecta o nariz do avião (confira o "+" vermelho em `art/preview.png`). Um avião antigo com hélice desenhada é editado automaticamente pelo `assets:all`. No jogo a hélice acelera na decolagem, ganha um disco de borrão em alta rotação e sai voando na queda. Tamanho, posição, velocidade e borrão ficam em `PLANE` no `src/config.js`; os quadros podem ser trocados por desenhos feitos à mão.
- Asset que não existir usa uma versão procedural desenhada em `src/textures.js`.

## Estrutura

| Arquivo | O quê |
|---|---|
| `src/config.js` | regras (margem da casa, curva), cores, **camadas de parallax** e nuvens |
| `src/game.js` | máquina de estados da rodada, apostas, saque, bots |
| `src/scene.js` | cena Three.js: parallax, curva, avião, partículas, explosão |
| `src/filmShader.js` | pós-processamento: granulado, vinheta, sépia, riscos, íris |
| `src/ui.js` / `src/audio.js` | painel de apostas (DOM) / sons sintetizados |
| `scripts/generate-assets.mjs` | gerador de imagens |

## Antes de dinheiro real

O crash point e o saldo hoje são calculados no navegador (só para protótipo). Em produção:
servidor autoritativo, crash provably fair (cadeia de seeds com hash publicado), carteira no backend
e licenciamento da operação no país onde o jogo vai operar.
