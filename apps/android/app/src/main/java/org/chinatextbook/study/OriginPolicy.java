package org.chinatextbook.study;

import java.net.URI;
import java.net.URISyntaxException;

/** The only origin allowed inside the privileged WebView. */
public final class OriginPolicy {
    private final URI origin;
    public OriginPolicy(String home) {
        origin = parse(home);
        if (!isHttps(origin)) throw new IllegalArgumentException("An HTTPS origin is required");
    }
    public boolean isTrusted(String url) {
        URI candidate = parse(url);
        return isHttps(candidate) && origin.getHost().equalsIgnoreCase(candidate.getHost())
                && port(origin) == port(candidate);
    }
    public static boolean isExternalHttps(String url) { return isHttps(parse(url)); }
    private static URI parse(String value) {
        try { return value == null ? null : new URI(value); }
        catch (URISyntaxException e) { return null; }
    }
    private static boolean isHttps(URI uri) {
        return uri != null && "https".equalsIgnoreCase(uri.getScheme())
                && uri.getHost() != null && uri.getUserInfo() == null;
    }
    private static int port(URI uri) { return uri.getPort() == -1 ? 443 : uri.getPort(); }
}
