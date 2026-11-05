# Month

The page's one section: a month of entries with its totals row, as on the spending page.

Components: table row (entry and totals), primary button ("Export"). Layout: 960 px max; header row in `label` type; columns date 72 px, payee flexible, category 160 px, amount 120 px right-aligned; `column-gap` between.
States: empty month is one `text-muted` line ("No entries for October"); a missing category shows "Uncategorised" in `text-muted`; a 9-digit amount keeps its column by widening, never wrapping.

![month](month.png)

```html
<section class="month">
  <h1 class="title">October</h1>
  <table>
    <thead><tr class="label"><th>Date</th><th>Payee</th><th>Category</th><th class="figure">Amount</th></tr></thead>
    <tbody><tr class="row"><td>Oct 3</td><td>Corner Grocer</td><td class="label">Food</td><td class="figure debit">−42.18</td></tr></tbody>
    <tfoot><tr class="total"><td colspan="3">Spent</td><td class="figure">1,204.77</td></tr></tfoot>
  </table>
</section>
```
