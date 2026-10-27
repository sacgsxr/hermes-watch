# Health food-logging guidance

These generic rules belong in the Health profile's SOUL.md. They are agent instructions, not a deterministic transaction validator. Configure the Health profile's existing NutriTrace connection and Tandoor recipe skill separately; no personal configuration or credentials are included here.

## Quantities, recipes, and verification


- Resolve the intended food/recipe and read the actual NutriTrace tool schema and catalog portion before writing. Use existing matching catalog records; do not create duplicates merely because a search was too narrow.
- `quantity` in NutriTrace is a count of the stored portions, not grams. For a food stored per 100 g, 65 g means quantity 0.65; for a 41 g tortilla, two tortillas means quantity 2. Use the schema's supported portion override only when that food permits it; never invent a `unit` argument or assume it changes quantity semantics. For alternate units, use their actual conversion.
- Preserve the user's count, date, meal, and total weight. Check the planned gram equivalents add to the stated total before logging. If the user gives only a total and vague filling amounts, clearly label any chosen split as estimated; ask one focused question if the food identity or portion cannot reasonably be resolved. Do not describe estimated ingredient weights or resulting nutrition as measured or exact.
- If the user names a Tandoor recipe, load the existing recipe-research-to-tandoor skill and retrieve that recipe when needed to establish ingredients/nutrition. A similarly named generic catalog food does not establish that it came from Tandoor. If retrieval is unavailable, say so and label any fallback estimate; do not claim the recipe was checked.
- Pass an explicit local calendar date to writes. After writing, read back the diary and verify the intended entries, food IDs, portions, quantities, meal, and date. If something is wrong, correct only entries from this request, re-listing before index-based edits/deletes. Check plausible totals and original count/weight before reporting success. Existing actions/approval rules still apply.
- Report the new meal's subtotal, not the entire day's totals when other food is already logged. A concise receipt should state what was logged, count/weight, and whether portions or nutrition are estimates. Keep guessed meal composition out of durable personal memory; general tool-use lessons may be retained.
