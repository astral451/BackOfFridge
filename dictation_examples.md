# Dictation examples

Real quick-add lines as iPhone dictation actually produced them, collected
to drive the parser fix (`parseQuickAdd` in `public/app.js`). Each one
becomes a test case: the raw text exactly as it landed in the box, and the
form fields it should fill.

Assumes a managed location named "Kitchen Fridge" exists, and the purchase
date is left at its default (today).

## Examples

### 1. No "expires", count and size merged by dictation

    Peanuts salted 224 ounces kitchen fridge May 16, 2027

Spoken as "two twenty four ounces"; the phone joined it into "224".

| Field      | Expected |
|------------|----------|
| Name       | Peanuts salted |
| Quantity   | 2 — **not recoverable from this text** (see note) |
| Unit/size  | 24 oz |
| Location   | Kitchen Fridge |
| Expires    | 2027-05-16 |

### 2. No "expires", stray commas, count spoken as a word

    Peanut salted, two, 24 ounces kitchen fridge, May 16, 2027

| Field      | Expected |
|------------|----------|
| Name       | Peanut salted |
| Quantity   | 2 |
| Unit/size  | 24 oz |
| Location   | Kitchen Fridge |
| Expires    | 2027-05-16 |

### 3. "quantity" keyword, merged numbers anyway, numeric date

    Peanut salted quantity 224 ounces kitchen fridge 05/16/2027

The "quantity" keyword alone didn't stop the phone merging "two" and
"twenty four" into "224".

| Field      | Expected |
|------------|----------|
| Name       | Peanut salted |
| Quantity   | 2 — **not recoverable from this text** (see note) |
| Unit/size  | 24 oz |
| Location   | Kitchen Fridge |
| Expires    | 2027-05-16 |

### 4. Fully keyworded

    Salted peanuts quantity two volume 24 ounces kitchen fridge expires May 16, 2027

| Field      | Expected |
|------------|----------|
| Name       | Salted peanuts |
| Quantity   | 2 |
| Unit/size  | 24 oz |
| Location   | Kitchen Fridge |
| Expires    | 2027-05-16 |

## Note: the merged-number case

Examples 1 and 3 can't be parsed correctly by any rule. Once dictation has
written "224", the text alone can't distinguish 2 × 24 oz, 22 × 4 oz, and a
single 224 oz item. A parser that guessed would sometimes be confidently
wrong. The fix has to happen in what's spoken: a word between the two
numbers keeps dictation from joining them (example 4's "two volume 24"
came through intact).

## Keywords: what's needed to always get it right

Rules as built in `parseQuickAdd` (`public/app.js`). Commas are mostly
ignored, because dictation places them unreliably. Every field is found
either by a keyword or by being unambiguous on its own.

| Field      | Needs a keyword? | Rule |
|------------|------------------|------|
| Name       | No  | The words before the quantity, commas or not. Dictation drops commas inside product names, so a comma never ends the name. Say it first. |
| Location   | No  | Matched (fuzzily) against the managed location list, anywhere in the line. |
| Tag        | No  | Matched against the managed tag list, anywhere in the line. |
| Expires    | Only for partial dates | A full date ("May 16, 2027", "05/16/2027") is taken as the expiration on its own. Purchase date defaults to today, so a bare date means expiration. A duration works without "expires" if it has "in" before it or "from today" after it: "in two weeks", "one month from today", "a month from today". A bare "2 weeks" with neither is left alone, because it could be a quantity. A date without a year ("expires May 16") or space-separated numbers ("expires 10 15 2026") still need "expires". "exp", "expiration", "best by" and "use by" also work. |
| Quantity + size | **Yes, when both are spoken** | "quantity two **size** 24 ounces". "**volume**" and "**weight**" work the same as "size". A comma (typed, or said as "comma") between the two numbers also works: "two, 24 ounces". |
| Quantity alone  | No  | "Milk 1 gallon" is fine: the first number, plus a unit if one follows. |
| Notes      | No  | Anything left over after the quantity/size. |

The only keyword that's *required* is the separator between count and size,
and a comma counts as one. Everything else is optional, and "expires" /
"quantity" still work as extra-explicit forms.

## Examples found while testing

### 5. Comma inside a brand name, size keyword

    Lesser evil, Himalayan pink salt popcorn, 21 size 1 ounce pan pantry March 8, 2027

| Field      | Expected |
|------------|----------|
| Name       | Lesser evil Himalayan pink salt popcorn |
| Quantity   | 21 (as written; meant to be 22, so dictation may have misheard) |
| Unit/size  | 1 oz |
| Location   | Pantry |
| Expires    | 2027-03-08 |
| Notes      | (empty: "pan" is a dictation stutter before "pantry" and is dropped) |

An earlier rule ended the name at the first comma, which cut this to
"Lesser evil". Removed: commas never end the name.

### 6. Relative expiration, no "expires"

How a duration from the purchase date (today by default) actually gets
said. Each works anywhere in the line, stray commas included:

    One week from today ,
    two weeks from today,
    one month from today,
    a month from today
    In two weeks in,
    In three weeks
    In one week
    In one month

"In two weeks in," has a trailing "in" from dictation, which is dropped
along with the duration.
