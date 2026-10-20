# SEO kit — The One Engine

Materiale pronto per un futuro sito di The One Engine e per la pubblicazione su npm
e GitHub. Oggi il motore non ha un sito: il suo manuale è su
<https://www.theoneincremental.com/docs>, e lì resta il canonical finché un sito
dedicato non viene pubblicato.

- `metadata.json`: per ogni pagina prevista (home, docs, API, balance lab, plugins,
  getting started) titolo (≤ 60 caratteri), descrizione (≤ 155), testo della card,
  politica di indicizzazione e tipo di dati strutturati; più parole chiave,
  descrizione npm e "about"/topics per GitHub. Copy redatto da Astra il 20/10/2026.
- `og/*.jpg`: card Open Graph 1200×630 per quelle pagine.
- `../.github/social-preview.jpg`: immagine social del repository (1280×640). Va
  caricata a mano in GitHub, Settings → General → Social preview: non è
  impostabile da git.

Regole: le pagine sono proposte, non esistenti. Niente canonical o URL assoluti verso
un dominio non ancora assegnato. Al lancio del sito, ogni capitolo di
`theoneincremental.com/docs` va reindirizzato in modo permanente alla pagina
equivalente.
