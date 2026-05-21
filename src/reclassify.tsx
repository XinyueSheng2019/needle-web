import type { TransientObject } from "./data";

type ReclassifyPageProps = {
  object: TransientObject;
};

/**
 * On-demand NEEDLE 2.0 re-classification workspace for one transient.
 * Placeholder sections match the planned explainability workflow in functionality-design.txt.
 */
export function ReclassifyPage({ object }: ReclassifyPageProps) {
  const sortedProbs = Object.entries(object.classProbabilities).sort((a, b) => b[1] - a[1]);
  const detailHref = `#object-detail?lasairId=${encodeURIComponent(object.lasairId)}`;

  return (
    <section className="content-section" id="reclassify">
      <div className="section-heading">
        <p className="eyebrow">NEEDLE 2.0</p>
        <h2>Re-classify {object.name}</h2>
        <p>
          Run an on-demand classification with multi-survey context, inspect CNN heatmaps, and review how
          metadata aligns with the trained feature space.
        </p>
        <p className="reclassify-back">
          <a href={detailHref}>← Back to object detail</a>
          <span className="muted-value">
            Lasair ID {object.lasairId}
          </span>
        </p>
      </div>

      <div className="reclassify-grid">

        <PlotLightCurves />

        <PlotImageHeatmap />
        <PlotMetaDistribution />

        <article className="panel reclassify-panel--wide">
          <p className="eyebrow">Explainability</p>
          <h2>Model decision process</h2>
          <p className="muted-value">
            SHAP-style feature attributions and decision narrative will appear here after re-classification.
          </p>
          <ul className="reclassify-feature-list reclassify-feature-list--placeholder">
            <li>
              <span>Color evolution</span>
              <span>—</span>
            </li>
            <li>
              <span>Host offset</span>
              <span>—</span>
            </li>
            <li>
              <span>Rise time</span>
              <span>—</span>
            </li>
          </ul>
        </article>
      </div>
    </section>
  );
}

export function PlotLightCurves() {
  return (
    <article className="panel">
      <p className="eyebrow">Light curves</p>
      <h2>Multi-survey light curves</h2>
      <p className="muted-value">
        Light curves for the selected surveys will appear here.
      </p>
    </article>
  );
}

export function PlotImageHeatmap() {
  return (
    <article className="panel">
      <p className="eyebrow">CNN explainability</p>
      <h2>Input image heatmap</h2>
      <div className="reclassify-placeholder" aria-hidden="true">
        Heatmap overlay
      </div>
      <p className="muted-value">Grad-CAM / attention map for the discovery stamp will render here.</p>
    </article>
  );
}

export function PlotMetaDistribution() {
  return (
    <article className="panel">
      <p className="eyebrow">Feature space</p>
      <h2>Metadata vs training distribution</h2>
      <div className="reclassify-placeholder" aria-hidden="true">
        Feature distribution plot
      </div>
      <p className="muted-value">
        Scatter of this object&apos;s metadata against the NEEDLE 2.0 training manifold.
      </p>
    </article>
  );
}
