import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { BookOpenText, ExternalLink } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { isCeRuntime } from "@/lib/runtime-config";
import styles from "@/components/login/login.module.css";

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.host);
  } catch {
    return false;
  }
}

const MoreInfoItemSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    title: z.string().trim().min(1).max(80),
    content_type: z.enum(["markdown", "image", "link"]),
    content: z.string().max(50_000),
    url: z.string().max(2_048),
    panel_width: z.number().int().min(240).max(960),
    panel_height: z.number().int().min(160).max(800),
    panel_width_auto: z.boolean(),
    panel_height_auto: z.boolean(),
  })
  .superRefine((item, context) => {
    if (item.content_type === "markdown" && item.content.trim().length === 0) {
      context.addIssue({
        code: "custom",
        path: ["content"],
        message: "Markdown content is required",
      });
    }
    const externalUrl = item.content_type === "image" ? item.content : item.url;
    if (item.content_type !== "markdown" && !isHttpUrl(externalUrl)) {
      context.addIssue({
        code: "custom",
        path: [item.content_type === "image" ? "content" : "url"],
        message: "External URL must use HTTP or HTTPS",
      });
    }
  });

const MoreInfoResponseSchema = z.object({
  items: z.array(MoreInfoItemSchema).max(30),
});

type MoreInfoItem = z.infer<typeof MoreInfoItemSchema>;

export function MoreInfoMenu() {
  const { t } = useTranslation();
  const [items, setItems] = useState<MoreInfoItem[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
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
        const parsed = MoreInfoResponseSchema.safeParse(body);
        setItems(parsed.success ? parsed.data.items : []);
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

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    const viewportPadding = 16;
    const contentRect = content.getBoundingClientRect();
    let correction = 0;
    if (contentRect.top < viewportPadding) {
      correction = viewportPadding - contentRect.top;
    } else if (contentRect.bottom > window.innerHeight - viewportPadding) {
      correction = window.innerHeight - viewportPadding - contentRect.bottom;
    }
    if (correction !== 0) {
      setActiveTop((current) => current + correction);
    }
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
      onPointerEnter={() => {
        clearActive();
        setMenuOpen(true);
      }}
      onPointerLeave={() => {
        clearActive();
        setMenuOpen(false);
      }}
      onFocusCapture={() => setMenuOpen(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setMenuOpen(false);
        }
      }}
    >
      <button
        type="button"
        className={styles.moreInfoTrigger}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onFocus={clearActive}
      >
        <BookOpenText aria-hidden="true" />
        <span>{t("loginCinematic.moreInfoShort")}</span>
      </button>
      <div className={styles.moreInfoPopover} aria-hidden={!menuOpen} inert={!menuOpen}>
        <div
          className={styles.moreInfoMenu}
          role="menu"
          aria-label={t("loginCinematic.moreInfo")}
        >
          {items.map((item) =>
            item.content_type === "link" ? (
              <a
                key={item.id}
                className={styles.moreInfoItem}
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
