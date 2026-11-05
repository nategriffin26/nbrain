# Table row

One entry of the ledger: date, payee, category and amount. Use the totals row instead for a sum.

Default variant: entry. Variants: entry, totals.

Tokens: `components.table-row`, `components.table-row-hover`; a 1 px `rule` line below; amounts in `typography.figure`, `credit` or `debit` colour.

| State | Looks like | Screenshot |
| --- | --- | --- |
| default | ink on paper, rule below | `table-row/default.png` |
| hover | row-selected background, 80 ms | `table-row/hover.png` |
| error | amount in debit colour, the reason inline in label type | `table-row/error.png` |

Good:
```html
<tr class="row"><td class="date">Oct 3</td><td>Corner Grocer</td><td class="label">Food</td><td class="figure debit">−42.18</td></tr>
```

Bad: a rounded card per entry with a shadow and a coloured category pill. Why: it turns a table into a feed and spends colour on categories.
