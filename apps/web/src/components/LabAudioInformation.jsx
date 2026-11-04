import { useState } from "react";
import SmoothDisclosure from "./SmoothDisclosure.jsx";
import {
  laboratoryTests,
  laboratoryCategories,
  filterLaboratoryTests,
  preparationNote,
  preparationSources,
  laboratoryFaqs,
  audiometryEntries,
  audiometryFaqs,
} from "../data/labAudioContent.js";
import "./labAudioInformation.css";

// Local line icons describe sample/test categories, not collection equipment.
export function ServiceSampleIcon({ kind }) {
  const paths = {
    blood: "M9 3h6m-5 0v11a4 4 0 0 0 8 0V3m-8 7h8M6 13c-4 5-4 8-1 8s4-3 1-8Z",
    urine: "M6 5h12M7 5l1 16h8l1-16M6 2h12v3H6ZM9 12h6",
    stool: "M5 6h14v15H5ZM8 2h8v4H8ZM9 11h6m-6 4h6",
    ear: "M8 8a5 5 0 0 1 10 0c0 4-4 4-4 8a3 3 0 0 1-6 0m3-8a2 2 0 0 1 4 0c0 2-3 2-3 5",
    hearing: "M5 13v-2a7 7 0 0 1 14 0v2M5 12H3v6h4v-6Zm14 0h2v6h-4v-6Z",
    speech: "M3 4h18v12h-9l-5 4v-4H3Zm4 5h10m-10 3h6",
  };
  return (
    <svg
      className="service-sample-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[kind]} />
    </svg>
  );
}

function Sources({ sources, checked = "2026-11-04" }) {
  return (
    <div className="service-content-sources">
      {sources.map((source) => (
        <p key={source.url}>
          <a href={source.url}>Source: MedlinePlus — {source.label}</a>
        </p>
      ))}
      <p>
        Checked <time dateTime={checked}>4 November 2026</time>
      </p>
    </div>
  );
}

export function LabAudioIntro({ laboratory }) {
  return (
    <div className="lab-audio-intro">
      <div>
        <h1>{laboratory ? "Laboratory" : "Audiometry"}</h1>
        <p>
          {laboratory
            ? "Find a test and understand how to prepare."
            : "A closer look at how hearing is assessed."}
        </p>
        <p>
          {laboratory
            ? "Explore the illustrative catalogue, then confirm your test and instructions with the laboratory."
            : "Learn about three hearing assessments performed by healthcare professionals. Contact reception for visit details."}
        </p>
        <a
          className="text-button"
          href={laboratory ? "#test-catalogue" : "#hearing-assessments"}
        >
          {laboratory ? "Explore the tests" : "Explore the assessments"}
        </a>
      </div>
      <div className="lab-audio-illustration" aria-hidden="true">
        <ServiceSampleIcon kind={laboratory ? "blood" : "hearing"} />
        <span>
          {laboratory
            ? "Know your test.\nPrepare with confidence."
            : "Tones. Words.\nMiddle-ear movement."}
        </span>
      </div>
    </div>
  );
}

export default function LabAudioInformation({ laboratory }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const filtered = filterLaboratoryTests(query, category);
  const faqs = laboratory ? laboratoryFaqs : audiometryFaqs;
  return (
    <>
      {laboratory ? (
        <section
          className="lab-catalogue"
          id="test-catalogue"
          aria-labelledby="test-catalogue-title"
        >
          <div className="service-content-heading">
            <h2 id="test-catalogue-title">Test catalogue</h2>
            <p>
              Illustrative capstone catalogue. Confirm test availability and
              preparation with the laboratory. Follow the instructions given for
              your own tests.
            </p>
            <p>{preparationNote}</p>
          </div>
          <div className="lab-catalogue-filters">
            <label>
              Search tests
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Test name or abbreviation"
              />
            </label>
            <label>
              Category
              <select
                value={category}
                onChange={(event) => setCategory(event.target.value)}
              >
                <option value="">All categories</option>
                {laboratoryCategories.map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            </label>
            {(query || category) && (
              <button
                type="button"
                className="button button-secondary"
                onClick={() => {
                  setQuery("");
                  setCategory("");
                }}
              >
                Reset filters
              </button>
            )}
          </div>
          <p className="lab-catalogue-count" role="status">
            {filtered.length} of {laboratoryTests.length} tests shown
            {!query && !category ? " · All tests" : ""}.
          </p>
          {filtered.length ? (
            <div className="lab-catalogue-grid">
              {filtered.map((test) => (
                <article
                  className="lab-test-card"
                  key={test.id}
                  data-test-id={test.id}
                >
                  <div className="lab-test-sample">
                    <ServiceSampleIcon
                      kind={
                        test.sample.startsWith("stool") ? "stool" : test.sample
                      }
                    />
                    <span>Sample: {test.sample}</span>
                  </div>
                  <h3>{test.name}</h3>
                  <p>{test.description}</p>
                  <SmoothDisclosure title="Preparation & details">
                    <h4>Preparation</h4>
                    <p>{test.preparation}</p>
                    <h4>{test.question}</h4>
                    <p>{test.answer}</p>
                    <Sources sources={test.sources} checked={test.checked} />
                  </SmoothDisclosure>
                </article>
              ))}
            </div>
          ) : (
            <div className="lab-catalogue-empty">
              <h3>No tests match these filters</h3>
              <p>
                Try another name or abbreviation, or reset the filters to see
                all tests.
              </p>
            </div>
          )}
        </section>
      ) : (
        <section
          className="audio-assessments"
          id="hearing-assessments"
          aria-labelledby="hearing-assessments-title"
        >
          <div className="service-content-heading">
            <h2 id="hearing-assessments-title">
              Understanding the assessments
            </h2>
            <p>
              Informational capstone presentation. Confirm actual service
              availability and visit instructions with reception.
            </p>
          </div>
          <div className="audio-assessment-grid">
            {audiometryEntries.map((entry) => (
              <article key={entry.id}>
                <ServiceSampleIcon kind={entry.icon} />
                <h3>{entry.name}</h3>
                <p>{entry.description}</p>
                <Sources sources={entry.sources} checked={entry.checked} />
              </article>
            ))}
          </div>
        </section>
      )}
      <section className="lab-audio-faq" aria-labelledby="service-faq-title">
        <div>
          <h2 id="service-faq-title">Before your visit</h2>
          <p>
            {laboratory
              ? "Use the instructions for your own test order. Contact reception for service details; online laboratory booking is not available."
              : "Contact reception for visit details. Online Audiometry booking is not available."}
          </p>
          <a className="text-button" href="/#contact">
            Reception information
          </a>
        </div>
        <div className="lab-audio-faq-panel">
          {faqs.map(([question, answer]) => (
            <SmoothDisclosure title={question} key={question}>
              <p>{answer}</p>
            </SmoothDisclosure>
          ))}
          {laboratory && <Sources sources={preparationSources} />}
        </div>
      </section>
    </>
  );
}
