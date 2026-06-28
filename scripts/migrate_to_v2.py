#!/usr/bin/env python3
"""Migrate the original español-srs JSON files to the versioned v2 model."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional


SCHEMA_VERSION = 2


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def lexeme_id(legacy_id: int) -> str:
    return f"lexeme:legacy:{legacy_id:04d}"


def card_id(legacy_id: int) -> str:
    return f"card:legacy:{legacy_id:04d}"


def lesson_id(cycle: int) -> str:
    return f"lesson:fsi:{cycle:02d}"


def segment_id(cycle: int, index: int) -> str:
    return f"segment:fsi:{cycle:02d}:{index:04d}"


def occurrence_id(legacy_id: int) -> str:
    return f"occurrence:legacy-card:{legacy_id:04d}"


def normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


def structured_cycles(directory: Optional[Path]) -> Dict[int, Dict[str, Any]]:
    if not directory:
        return {}
    result = {}
    for path in directory.glob("cycle-*.json"):
        payload = read_json(path)
        result[int(payload["cycle"])] = payload
    return result


def closest_structured_segment(
    candidates: List[Dict[str, Any]], start: float, end: float
) -> Optional[Dict[str, Any]]:
    if not candidates:
        return None
    best = min(
        candidates,
        key=lambda item: abs(float(item["start"]) - start)
        + abs(float(item["end"]) - end),
    )
    distance = abs(float(best["start"]) - start) + abs(float(best["end"]) - end)
    return best if distance <= 1.2 else None


def validate(
    lexemes: List[Dict[str, Any]],
    cards: List[Dict[str, Any]],
    lessons: List[Dict[str, Any]],
    segments: List[Dict[str, Any]],
    occurrences: List[Dict[str, Any]],
    vocabulary: List[Dict[str, Any]],
) -> None:
    collections = {
        "lexeme": lexemes,
        "card": cards,
        "lesson": lessons,
        "segment": segments,
        "occurrence": occurrences,
        "lesson vocabulary": vocabulary,
    }
    for label, rows in collections.items():
        ids = [row["id"] for row in rows]
        if len(ids) != len(set(ids)):
            raise ValueError(f"Duplicate {label} IDs")

    lexeme_ids = {row["id"] for row in lexemes}
    card_ids = {row["id"] for row in cards}
    lesson_ids = {row["id"] for row in lessons}
    segment_ids = {row["id"] for row in segments}
    occurrence_ids = {row["id"] for row in occurrences}

    if any(card["lexeme_id"] not in lexeme_ids for card in cards):
        raise ValueError("Card references a missing lexeme")
    if any(
        occurrence["lesson_id"] is not None
        and occurrence["lesson_id"] not in lesson_ids
        for occurrence in occurrences
    ):
        raise ValueError("Occurrence references a missing lesson")
    if any(
        segment not in segment_ids
        for occurrence in occurrences
        for segment in occurrence["segment_ids"]
    ):
        raise ValueError("Occurrence references a missing segment")
    if any(
        occurrence not in occurrence_ids
        for card in cards
        for occurrence in card["example_occurrence_ids"]
    ):
        raise ValueError("Card references a missing occurrence")
    if any(
        row["lesson_id"] not in lesson_ids or row["lexeme_id"] not in lexeme_ids
        for row in vocabulary
    ):
        raise ValueError("Lesson vocabulary has a missing reference")
    if any(
        occurrence not in occurrence_ids
        for row in vocabulary
        for occurrence in row["occurrence_ids"]
    ):
        raise ValueError("Lesson vocabulary references a missing occurrence")

    for lesson in lessons:
        lesson_segments = [
            segment for segment in segments if segment["lesson_id"] == lesson["id"]
        ]
        previous_end = -1.0
        for segment in lesson_segments:
            if segment["start_seconds"] < previous_end:
                raise ValueError(f"Segments are out of order in {lesson['id']}")
            if segment["end_seconds"] <= segment["start_seconds"]:
                raise ValueError(f"Invalid segment duration in {segment['id']}")
            previous_end = segment["end_seconds"]


def migrate(root: Path, structured_dir: Optional[Path]) -> None:
    legacy_cards = read_json(root / "data.json")
    legacy_lessons = read_json(root / "cycles.json")
    legacy_course = read_json(root / "cycle_data.json")
    structured = structured_cycles(structured_dir)

    lexemes: List[Dict[str, Any]] = []
    cards: List[Dict[str, Any]] = []
    occurrences: List[Dict[str, Any]] = []
    occurrence_by_legacy: Dict[int, Dict[str, Any]] = {}

    for legacy in legacy_cards:
        legacy_id = int(legacy["id"])
        lid = lexeme_id(legacy_id)
        oid = occurrence_id(legacy_id)
        cycle = legacy.get("cycle")
        occurrence = {
            "id": oid,
            "lexeme_id": lid,
            "lesson_id": lesson_id(int(cycle)) if cycle is not None else None,
            "segment_ids": [],
            "text_es": normalize_text(legacy.get("x")),
            "text_en": normalize_text(legacy.get("y")),
            "audio_clip": (
                {
                    "audio_asset_id": f"audio:fsi:{int(cycle):02d}",
                    "start_seconds": float(legacy["audio_start"]),
                    "end_seconds": float(legacy["audio_end"]),
                }
                if cycle is not None and legacy.get("audio_start") is not None
                else None
            ),
            "source": {
                "kind": "legacy_card_example",
                "legacy_card_id": legacy_id,
            },
        }
        occurrences.append(occurrence)
        occurrence_by_legacy[legacy_id] = occurrence
        lexemes.append(
            {
                "id": lid,
                "lemma": normalize_text(legacy["es"]),
                "part_of_speech": legacy["pos"],
                "translations_en": [normalize_text(legacy["en"])],
                "definition_es": normalize_text(legacy.get("def")),
                "grammatical": {},
                "categories": [legacy["cat"]],
                "source": {
                    "kind": "legacy_deck",
                    "legacy_id": legacy_id,
                },
            }
        )
        cards.append(
            {
                "id": card_id(legacy_id),
                "lexeme_id": lid,
                "card_type": "recognition_es_en",
                "prompt": normalize_text(legacy["es"]),
                "answer": normalize_text(legacy["en"]),
                "example_occurrence_ids": [oid],
                "default_in_deck": True,
                "source": {
                    "kind": "legacy_deck",
                    "legacy_id": legacy_id,
                },
            }
        )

    lessons: List[Dict[str, Any]] = []
    segments: List[Dict[str, Any]] = []
    segments_by_cycle: Dict[int, List[Dict[str, Any]]] = {}
    for legacy in legacy_lessons:
        cycle = int(legacy["num"])
        structured_lesson = structured.get(cycle)
        title = (
            structured_lesson["title"] if structured_lesson else legacy["title"]
        )
        source = {
            "course": "FSI Spanish Familiarization and Short-Term Training",
            "cycle": cycle,
        }
        if structured_lesson:
            source["manual"] = {
                "filename": structured_lesson["source"]["manual_filename"],
                "pdf_pages": structured_lesson["source"]["pdf_pages"],
            }
        lessons.append(
            {
                "id": lesson_id(cycle),
                "course_id": "course:fsi-spanish-familiarization",
                "number": cycle,
                "title": title,
                "duration_seconds": float(legacy["duration"]),
                "audio_asset": {
                    "id": f"audio:fsi:{cycle:02d}",
                    "path": f"audio/Cycle {cycle}.mp3",
                    "media_type": "audio/mpeg",
                },
                "sections": (
                    [
                        {
                            "id": section["id"],
                            "title": section["title"],
                            "type": section["type"],
                            "pdf_pages": section["pdf_pages"],
                        }
                        for section in structured_lesson["sections"]
                    ]
                    if structured_lesson
                    else []
                ),
                "source": source,
            }
        )
        structured_segments = (
            structured_lesson["audio"]["segments"] if structured_lesson else []
        )
        cycle_segments: List[Dict[str, Any]] = []
        for index, segment in enumerate(legacy_course["segments"][str(cycle)], start=1):
            aligned = closest_structured_segment(
                structured_segments, float(segment["s"]), float(segment["e"])
            )
            row = {
                "id": segment_id(cycle, index),
                "lesson_id": lesson_id(cycle),
                "sequence": index,
                "language": "es",
                "text": normalize_text(segment["t"]),
                "start_seconds": float(segment["s"]),
                "end_seconds": float(segment["e"]),
                "speaker_role": None,
                "manual_reference": (
                    aligned.get("manual_alignment") if aligned else None
                ),
                "source": {
                    "kind": "faster_whisper_filtered",
                    "legacy_cycle": cycle,
                    "legacy_index": index - 1,
                },
            }
            segments.append(row)
            cycle_segments.append(row)
        segments_by_cycle[cycle] = cycle_segments

    # Link legacy examples to every Spanish segment touched by their clip.
    for legacy in legacy_cards:
        cycle = legacy.get("cycle")
        if cycle is None or legacy.get("audio_start") is None:
            continue
        occurrence = occurrence_by_legacy[int(legacy["id"])]
        start, end = float(legacy["audio_start"]), float(legacy["audio_end"])
        occurrence["segment_ids"] = [
            segment["id"]
            for segment in segments_by_cycle[int(cycle)]
            if segment["start_seconds"] < end and segment["end_seconds"] > start
        ]

    vocabulary: List[Dict[str, Any]] = []
    for cycle_key, words in legacy_course["words"].items():
        cycle = int(cycle_key)
        for word in words:
            legacy_id = int(word["id"])
            occurrence = occurrence_by_legacy[legacy_id]
            occurrence_ids = (
                [occurrence["id"]]
                if occurrence["lesson_id"] == lesson_id(cycle)
                else []
            )
            vocabulary.append(
                {
                    "id": f"lesson-vocabulary:fsi:{cycle:02d}:{legacy_id:04d}",
                    "lesson_id": lesson_id(cycle),
                    "lexeme_id": lexeme_id(legacy_id),
                    "occurrence_ids": occurrence_ids,
                    "role": "course_vocabulary",
                    "priority": None,
                    "source": {
                        "kind": "legacy_cycle_vocabulary",
                        "confidence": "unreviewed",
                    },
                }
            )

    validate(lexemes, cards, lessons, segments, occurrences, vocabulary)

    output = root / "content-v2"
    entities = {
        "lexemes": lexemes,
        "cards": cards,
        "lessons": lessons,
        "segments": segments,
        "occurrences": occurrences,
        "lesson_vocabulary": vocabulary,
    }
    for name, rows in entities.items():
        write_json(output / f"{name}.json", rows)

    bundle = {
        "schema_version": SCHEMA_VERSION,
        "content_version": "2.0.0",
        "course": {
            "id": "course:fsi-spanish-familiarization",
            "title": "FSI Spanish Familiarization and Short-Term Training",
        },
        "entities": entities,
    }
    bundle_path = root / "app_data_v2.json"
    write_json(bundle_path, bundle)
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "content_version": "2.0.0",
        "counts": {name: len(rows) for name, rows in entities.items()},
        "runtime_bundle": {
            "path": bundle_path.name,
            "sha256": sha256(bundle_path),
        },
        "legacy_inputs": {
            name: sha256(root / name)
            for name in ("data.json", "cycles.json", "cycle_data.json")
        },
    }
    write_json(output / "manifest.json", manifest)
    print(json.dumps(manifest["counts"], indent=2))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="App root",
    )
    parser.add_argument(
        "--structured-course",
        type=Path,
        help="Optional directory containing cycle-NN.json manual alignments",
    )
    args = parser.parse_args()
    migrate(
        args.root.resolve(),
        args.structured_course.resolve() if args.structured_course else None,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

