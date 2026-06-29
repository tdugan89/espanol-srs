# Data model v2

Version 2 separates durable learning content from presentation and user state.
The normalized source entities live in `content-v2/`; `app_data_v2.json` is a
generated runtime bundle containing the same entities for efficient loading in
the static PWA.

## Content entities

- **Lexeme**: one meaning/sense of a Spanish lemma, with translations,
  grammatical metadata, and categories.
- **Card**: a review prompt/answer connected to a lexeme. Multiple cards may
  eventually represent one lexeme.
- **Lesson**: an FSI cycle, its audio asset, manual pages, and section metadata.
- **Segment**: one timestamped, language-tagged span of lesson audio.
- **Occurrence**: an example of a lexeme in context, optionally connected to
  lesson segments and an audio clip.
- **LessonVocabulary**: the many-to-many relationship between lessons and
  lexemes, including occurrences, role, priority, provenance, and confidence.
- **VisualCue**: a curated emoji or local image attached to one specific
  lexeme/sense, with Spanish alt text and source provenance.

IDs are stable strings. Migrated IDs retain their legacy identity, such as
`lexeme:legacy:0042`; future imports should use generated UUIDs and must never
renumber existing entities.

## User state

Browser state is stored under `esrs_user_v2`:

```json
{
  "schema_version": 2,
  "cards": {
    "card:legacy:0042": {
      "in_deck": true,
      "reps": 3,
      "interval": 12,
      "ease_factor": 2.5,
      "due_at": 1780000000000,
      "lapses": 0,
      "first_seen_on": "2026-06-28"
    }
  },
  "review_events": [],
  "hint_events": [],
  "audio_events": [],
  "quiz_events": [],
  "lesson_progress": {},
  "settings": {"new_per_day": 20},
  "stats": {},
  "current_lesson_id": "lesson:fsi:03"
}
```

Deck membership and scheduling state are distinct. A card can be in the deck
without having been reviewed. Review, hint, audio, and cloze-quiz histories are
append-only. Cloze results also create review events with `mode: "cloze"` so
typed recall feeds the same scheduler as flashcard ratings.

On first v2 launch, the app migrates the original v1 localStorage keys using
each card's retained `source.legacy_id`. The old keys remain untouched as a
rollback copy.

## Rebuilding

```bash
python3 scripts/migrate_to_v2.py \
  --structured-course /path/to/fsi-course-data/course
```

Without `--structured-course`, the model is still generated, but manual section
and PDF-alignment fields remain empty.
