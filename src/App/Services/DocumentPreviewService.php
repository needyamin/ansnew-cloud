<?php

declare(strict_types=1);

namespace App\Services;

use App\Storage\StorageAdapter;
use DOMDocument;
use DOMElement;
use DOMNode;
use DOMXPath;
use RuntimeException;
use ZipArchive;

/**
 * Renders office documents to a small, SAFE subset of HTML for the in-app
 * preview — no external binaries, no composer packages. The container formats
 * we can read without a library are the ZIP+XML ones (OOXML .docx, OpenDocument
 * .odt) plus the text-based .rtf; the legacy binary .doc (an OLE compound file)
 * is deliberately reported as unsupported rather than guessed at.
 *
 * Security: the output is built by us from a whitelist of tags (h1-h6, p, ul,
 * ol, li, strong, em, u, s, br, table/tr/td) with every piece of document text
 * HTML-escaped. Nothing from the document is ever emitted as markup, so a
 * malicious document cannot inject script/HTML into the viewer.
 */
final class DocumentPreviewService
{
    private const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    private const TEXT_NS = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';
    private const OFFICE_NS = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0';

    /** Guard rails so a pathological document cannot exhaust memory. */
    private const MAX_BLOCKS = 4000;
    private const MAX_CHARS = 300000;

    /** Extensions this service knows how to render. */
    public static function supports(string $ext): bool
    {
        return in_array(strtolower($ext), ['docx', 'odt', 'rtf'], true);
    }

    /**
     * @return array{kind:string, html:string, truncated:bool}
     */
    public static function render(StorageAdapter $adapter, string $path, string $ext): array
    {
        $ext = strtolower($ext);

        // ZIP/RTF parsers want a real file, and the adapter hands back a
        // DECRYPTED stream — so spill it to a private temp file and remove it
        // immediately after. Nothing decrypted is left on disk.
        $tmp = tempnam(sys_get_temp_dir(), 'ansdoc_');
        if ($tmp === false) {
            throw new RuntimeException('Could not create a temporary file');
        }
        try {
            $in = $adapter->getStream($path);
            $out = fopen($tmp, 'wb');
            if ($out === false) {
                throw new RuntimeException('Could not open the temporary file');
            }
            try {
                stream_copy_to_stream($in, $out);
            } finally {
                if (is_resource($in)) {
                    fclose($in);
                }
                fclose($out);
            }

            return match ($ext) {
                'docx' => self::renderDocx($tmp),
                'odt' => self::renderOdt($tmp),
                'rtf' => self::renderRtf($tmp),
                default => ['kind' => 'unsupported', 'html' => '', 'truncated' => false],
            };
        } finally {
            @unlink($tmp);
        }
    }

    /* ------------------------------------------------------------------ docx */

    /** @return array{kind:string, html:string, truncated:bool} */
    private static function renderDocx(string $file): array
    {
        $xml = self::zipEntry($file, 'word/document.xml');
        if ($xml === null) {
            return ['kind' => 'unsupported', 'html' => '', 'truncated' => false];
        }
        $dom = self::loadXml($xml);
        if ($dom === null) {
            return ['kind' => 'unsupported', 'html' => '', 'truncated' => false];
        }
        $xp = new DOMXPath($dom);
        $xp->registerNamespace('w', self::W_NS);
        $body = $xp->query('/w:document/w:body')->item(0);
        if (!$body instanceof DOMElement) {
            return ['kind' => 'unsupported', 'html' => '', 'truncated' => false];
        }

        [$html, $truncated] = self::docxBlocks($xp, $body);
        return ['kind' => 'docx', 'html' => $html, 'truncated' => $truncated];
    }

    /** @return array{0:string,1:bool} */
    private static function docxBlocks(DOMXPath $xp, DOMElement $body): array
    {
        $out = [];
        $blocks = 0;
        $chars = 0;
        $listOpen = false;

        foreach ($body->childNodes as $node) {
            if (!$node instanceof DOMElement) {
                continue;
            }
            $ln = $node->localName;

            if ($ln === 'p') {
                [$tag, $inner] = self::docxParagraph($xp, $node);
                $isList = $tag === 'p' && $xp->query('./w:pPr/w:numPr', $node)->length > 0;
                if ($isList) {
                    if (!$listOpen) {
                        $out[] = '<ul>';
                        $listOpen = true;
                    }
                    $out[] = '<li>' . $inner . '</li>';
                } else {
                    if ($listOpen) {
                        $out[] = '</ul>';
                        $listOpen = false;
                    }
                    $out[] = '<' . $tag . '>' . $inner . '</' . $tag . '>';
                }
            } elseif ($ln === 'tbl') {
                if ($listOpen) {
                    $out[] = '</ul>';
                    $listOpen = false;
                }
                $out[] = self::docxTable($xp, $node);
            } else {
                continue;
            }

            $blocks++;
            $chars += strlen(end($out) ?: '');
            if ($blocks >= self::MAX_BLOCKS || $chars >= self::MAX_CHARS) {
                if ($listOpen) {
                    $out[] = '</ul>';
                }
                $out[] = '<p class="muted">… document truncated for preview …</p>';
                return [implode("\n", $out), true];
            }
        }
        if ($listOpen) {
            $out[] = '</ul>';
        }
        return [implode("\n", $out), false];
    }

    /** @return array{0:string,1:string} [tag, innerHtml] */
    private static function docxParagraph(DOMXPath $xp, DOMElement $p): array
    {
        $tag = 'p';
        $style = $xp->query('./w:pPr/w:pStyle/@w:val', $p)->item(0);
        if ($style !== null) {
            $val = (string) $style->nodeValue;
            if (preg_match('/^Heading\s*([1-6])$/i', $val, $m)) {
                $tag = 'h' . $m[1];
            } elseif (preg_match('/^Title$/i', $val)) {
                $tag = 'h1';
            } elseif (preg_match('/^Subtitle$/i', $val)) {
                $tag = 'h2';
            }
        }
        return [$tag, self::docxInline($xp, $p)];
    }

    private static function docxInline(DOMXPath $xp, DOMElement $p): string
    {
        $html = '';
        foreach ($p->childNodes as $child) {
            if (!$child instanceof DOMElement) {
                continue;
            }
            if ($child->localName === 'r') {
                $html .= self::docxRun($xp, $child);
            } elseif ($child->localName === 'hyperlink') {
                foreach ($child->childNodes as $r) {
                    if ($r instanceof DOMElement && $r->localName === 'r') {
                        $html .= self::docxRun($xp, $r);
                    }
                }
            }
        }
        return $html;
    }

    private static function docxRun(DOMXPath $xp, DOMElement $r): string
    {
        $text = '';
        foreach ($r->childNodes as $c) {
            if (!$c instanceof DOMElement) {
                continue;
            }
            switch ($c->localName) {
                case 't':
                    $text .= $c->textContent;
                    break;
                case 'tab':
                    $text .= "\t";
                    break;
                case 'br':
                case 'cr':
                    $text .= "\n";
                    break;
                case 'noBreakHyphen':
                    $text .= '-';
                    break;
                case 'drawing':
                case 'pict':
                case 'object':
                    $text .= '[image]';
                    break;
            }
        }
        if ($text === '') {
            return '';
        }
        $html = self::inlineHtml($text);

        $rPr = $xp->query('./w:rPr', $r)->item(0);
        if ($rPr instanceof DOMElement) {
            if (self::docxToggle($rPr, 'strike')) {
                $html = '<s>' . $html . '</s>';
            }
            if (self::docxToggle($rPr, 'u')) {
                $html = '<u>' . $html . '</u>';
            }
            if (self::docxToggle($rPr, 'i')) {
                $html = '<em>' . $html . '</em>';
            }
            if (self::docxToggle($rPr, 'b')) {
                $html = '<strong>' . $html . '</strong>';
            }
        }
        return $html;
    }

    /** A bare <w:b/> means "on"; <w:b w:val="0"/> means "off". */
    private static function docxToggle(DOMElement $rPr, string $name): bool
    {
        foreach ($rPr->childNodes as $n) {
            if (!$n instanceof DOMElement || $n->localName !== $name) {
                continue;
            }
            foreach ($n->attributes as $a) {
                if ($a->localName === 'val') {
                    $v = strtolower(trim($a->nodeValue));
                    return !in_array($v, ['0', 'false', 'off', 'none'], true);
                }
            }
            return true;
        }
        return false;
    }

    private static function docxTable(DOMXPath $xp, DOMElement $tbl): string
    {
        $rows = '';
        foreach ($xp->query('./w:tr', $tbl) as $tr) {
            $cells = '';
            foreach ($xp->query('./w:tc', $tr) as $tc) {
                $inner = '';
                foreach ($xp->query('./w:p', $tc) as $p) {
                    if ($p instanceof DOMElement) {
                        $t = self::docxInline($xp, $p);
                        if ($t !== '') {
                            $inner .= ($inner === '' ? '' : '<br>') . $t;
                        }
                    }
                }
                $cells .= '<td>' . $inner . '</td>';
            }
            $rows .= '<tr>' . $cells . '</tr>';
        }
        return '<table>' . $rows . '</table>';
    }

    /* ------------------------------------------------------------------- odt */

    /** @return array{kind:string, html:string, truncated:bool} */
    private static function renderOdt(string $file): array
    {
        $xml = self::zipEntry($file, 'content.xml');
        if ($xml === null) {
            return ['kind' => 'unsupported', 'html' => '', 'truncated' => false];
        }
        $dom = self::loadXml($xml);
        if ($dom === null) {
            return ['kind' => 'unsupported', 'html' => '', 'truncated' => false];
        }
        $xp = new DOMXPath($dom);
        $xp->registerNamespace('office', self::OFFICE_NS);
        $xp->registerNamespace('text', self::TEXT_NS);
        $body = $xp->query('/office:document-content/office:body/office:text')->item(0);
        if (!$body instanceof DOMElement) {
            return ['kind' => 'unsupported', 'html' => '', 'truncated' => false];
        }

        $out = [];
        $blocks = 0;
        $chars = 0;
        $truncated = false;
        foreach ($body->childNodes as $node) {
            if (!$node instanceof DOMElement) {
                continue;
            }
            $block = match ($node->localName) {
                'h' => self::odtHeading($node),
                'p' => '<p>' . self::inlineHtml(self::odtInline($node)) . '</p>',
                'list' => self::odtList($node),
                default => '',
            };
            if ($block === '') {
                continue;
            }
            $out[] = $block;
            $blocks++;
            $chars += strlen($block);
            if ($blocks >= self::MAX_BLOCKS || $chars >= self::MAX_CHARS) {
                $out[] = '<p class="muted">… document truncated for preview …</p>';
                $truncated = true;
                break;
            }
        }
        return ['kind' => 'odt', 'html' => implode("\n", $out), 'truncated' => $truncated];
    }

    private static function odtHeading(DOMElement $h): string
    {
        $lvl = 1;
        foreach ($h->attributes as $a) {
            if ($a->localName === 'outline-level') {
                $lvl = max(1, min(6, (int) $a->nodeValue));
            }
        }
        return '<h' . $lvl . '>' . self::inlineHtml(self::odtInline($h)) . '</h' . $lvl . '>';
    }

    private static function odtList(DOMElement $list): string
    {
        $items = '';
        foreach ($list->childNodes as $li) {
            if (!$li instanceof DOMElement || $li->localName !== 'list-item') {
                continue;
            }
            $inner = '';
            foreach ($li->childNodes as $c) {
                if ($c instanceof DOMElement && $c->localName === 'p') {
                    $inner .= self::inlineHtml(self::odtInline($c));
                }
            }
            $items .= '<li>' . $inner . '</li>';
        }
        return '<ul>' . $items . '</ul>';
    }

    /** Recursively collect text, honouring ODF's space/tab/break elements. */
    private static function odtInline(DOMNode $node): string
    {
        $s = '';
        foreach ($node->childNodes as $c) {
            if ($c->nodeType === XML_TEXT_NODE || $c->nodeType === XML_CDATA_SECTION_NODE) {
                $s .= $c->nodeValue;
            } elseif ($c instanceof DOMElement) {
                switch ($c->localName) {
                    case 's':
                        $n = 1;
                        foreach ($c->attributes as $a) {
                            if ($a->localName === 'c') {
                                $n = max(1, (int) $a->nodeValue);
                            }
                        }
                        $s .= str_repeat(' ', $n);
                        break;
                    case 'tab':
                        $s .= "\t";
                        break;
                    case 'line-break':
                        $s .= "\n";
                        break;
                    default:
                        $s .= self::odtInline($c);
                }
            }
        }
        return $s;
    }

    /* ------------------------------------------------------------------- rtf */

    /** @return array{kind:string, html:string, truncated:bool} */
    private static function renderRtf(string $file): array
    {
        $raw = (string) file_get_contents($file);
        $text = self::rtfToText($raw);
        $html = '';
        foreach (preg_split('/\n+/', $text) ?: [] as $para) {
            $para = trim($para);
            if ($para === '') {
                continue;
            }
            $html .= '<p>' . self::inlineHtml($para) . '</p>';
        }
        return ['kind' => 'rtf', 'html' => $html, 'truncated' => false];
    }

    /** Best-effort RTF -> plain text. Crude by design; RTF is rarely authored. */
    private static function rtfToText(string $s): string
    {
        // Hex escapes \'hh -> byte
        $s = preg_replace_callback("/\\\\'([0-9a-fA-F]{2})/", static fn ($m) => chr((int) hexdec($m[1])), $s) ?? $s;
        // Unicode \uN? -> character
        $s = preg_replace_callback('/\\\\u(-?\d+)\s?\??/', static function ($m) {
            $n = (int) $m[1];
            if ($n < 0) {
                $n += 65536;
            }
            return mb_chr($n, 'UTF-8');
        }, $s) ?? $s;
        // Structural controls -> newlines / tabs
        $s = preg_replace('/\\\\(par|line|pard)\b ?/', "\n", $s) ?? $s;
        $s = preg_replace('/\\\\tab\b ?/', "\t", $s) ?? $s;
        // Drop every remaining control word / symbol
        $s = preg_replace('/\\\\[a-zA-Z]+-?\d* ?/', '', $s) ?? $s;
        $s = preg_replace('/\\\\[^a-zA-Z]/', '', $s) ?? $s;
        // Braces are group delimiters, never content
        return str_replace(['{', '}'], '', $s);
    }

    /* ---------------------------------------------------------------- helpers */

    private static function zipEntry(string $file, string $entry): ?string
    {
        $zip = new ZipArchive();
        if ($zip->open($file) !== true) {
            return null;
        }
        try {
            $data = $zip->getFromName($entry);
        } finally {
            $zip->close();
        }
        return is_string($data) && $data !== '' ? $data : null;
    }

    private static function loadXml(string $xml): ?DOMDocument
    {
        $dom = new DOMDocument();
        $prev = libxml_use_internal_errors(true);
        $ok = $dom->loadXML($xml, LIBXML_NONET | LIBXML_NOENT | LIBXML_NOCDATA);
        libxml_clear_errors();
        libxml_use_internal_errors($prev);
        return $ok ? $dom : null;
    }

    /** Escape text and turn control whitespace into HTML without allowing tags. */
    private static function inlineHtml(string $text): string
    {
        $esc = htmlspecialchars($text, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        $esc = str_replace("\t", '&nbsp;&nbsp;&nbsp;&nbsp;', $esc);
        return str_replace("\n", '<br>', $esc);
    }
}
