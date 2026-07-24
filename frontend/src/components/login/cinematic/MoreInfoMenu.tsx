import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { ExternalLink, MoreHorizontal } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { isCeRuntime } from "@/lib/runtime-config";
import styles from "@/components/login/login.module.css";

type MoreInfoItem = {
  id: string;
  title: string;
  content_type: "markdown" | "image" | "link";
  content: string;
  url: string;
  panel_width: number;
  panel_height: number;
  panel_width_auto: boolean;
  panel_height_auto: boolean;
};

export function MoreInfoMenu() {
  const [items, setItems] = useState<MoreInfoItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeTop, setActiveTop] = useState(7);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isCeRuntime()) return;
    const controller = new AbortController();
    fetch("/api/v1/site/more-info", {
      credentials: "include",
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        const next = Array.isArray(body?.items) ? body.items : [];
        setItems(next);
        setActiveId(null);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const element = contentRef.current;
    if (!element) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? element.clientHeight
            : 1;
      element.scrollTop += event.deltaY * unit;
    };
    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleWheel);
  }, [activeId]);

  if (isCeRuntime() || items.length === 0) return null;

  const active = items.find((item) => item.id === activeId && item.content_type !== "link");
  const clearActive = () => {
    setActiveId(null);
    setActiveTop(7);
  };

  return (
    <div
      className={styles.moreInfo}
      onMouseEnter={clearActive}
      onMouseLeave={clearActive}
    >
      <button
        type="button"
        className={styles.moreInfoTrigger}
        aria-haspopup="menu"
        onFocus={clearActive}
      >
        <MoreHorizontal aria-hidden="true" />
        <span>更多信息</span>
      </button>
      <div className={styles.moreInfoPopover}>
        <div className={styles.moreInfoMenu} role="menu" aria-label="更多信息">
          {items.map((item) =>
            item.content_type === "link" ? (
              <a
                key={item.id}
                className={`${styles.moreInfoItem} ${styles.moreInfoLinkItem}`}
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                role="menuitem"
                onMouseEnter={clearActive}
                onFocus={clearActive}
              >
                <span>{item.title}</span>
                <ExternalLink aria-hidden="true" />
              </a>
            ) : (
              <button
                key={item.id}
                type="button"
                className={`${styles.moreInfoItem} ${
                  active?.id === item.id ? styles.moreInfoItemActive : ""
                }`}
                onMouseEnter={(event) => {
                  setActiveId(item.id);
                  setActiveTop(event.currentTarget.offsetTop);
                }}
                onFocus={(event) => {
                  setActiveId(item.id);
                  setActiveTop(event.currentTarget.offsetTop);
                }}
                onClick={(event) => {
                  setActiveId(item.id);
                  setActiveTop(event.currentTarget.offsetTop);
                }}
                role="menuitem"
              >
                {item.title}
              </button>
            ),
          )}
        </div>
        {active && (
          <div
            ref={contentRef}
            className={`${styles.moreInfoContent} ${
              active.panel_width_auto ? styles.moreInfoContentAutoWidth : ""
            } ${
              active.panel_height_auto ? styles.moreInfoContentAutoHeight : ""
            }`}
            style={
              {
                "--more-info-active-top": `${activeTop}px`,
                "--more-info-panel-width": `${active.panel_width || 360}px`,
                "--more-info-panel-height": `${active.panel_height || 440}px`,
              } as CSSProperties
            }
          >
            {active.content_type === "image" ? (
              <img src={active.content} alt={active.title} draggable={false} />
            ) : (
              <div className={styles.moreInfoMarkdown}>
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    a: ({ children, ...props }) => (
                      <a {...props} target="_blank" rel="noopener noreferrer">
                        {children}
                      </a>
                    ),
                  }}
                >
                  {active.content}
                </ReactMarkdown>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
