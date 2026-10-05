package org.chinatextbook.study;
import org.junit.Test;
import static org.junit.Assert.*;

public class OriginPolicyTest {
    private final OriginPolicy policy = new OriginPolicy("https://school.example/");
    @Test public void acceptsRoutesAndEquivalentDefaultPort() {
        assertTrue(policy.isTrusted("https://school.example/lesson/g1up/?from=home"));
        assertTrue(policy.isTrusted("https://SCHOOL.example:443/"));
    }
    @Test public void rejectsDeceptiveHostsAndCredentials() {
        assertFalse(policy.isTrusted("https://school.example.attacker.test/"));
        assertFalse(policy.isTrusted("https://attacker.test/?school.example"));
        assertFalse(policy.isTrusted("https://school.example@attacker.test/"));
        assertFalse(policy.isTrusted("https://user@school.example/"));
    }
    @Test public void rejectsOtherPortsAndSchemes() {
        for (String url : new String[]{"http://school.example/", "https://school.example:444/", "javascript:alert(1)", "file:///etc/passwd", "data:text/html,hello", "intent://school.example", "bad url", null}) {
            assertFalse(policy.isTrusted(url));
        }
    }
    @Test public void externalLinksMustAlsoBeHttps() {
        assertTrue(OriginPolicy.isExternalHttps("https://github.com/example"));
        assertFalse(OriginPolicy.isExternalHttps("tel:123"));
        assertFalse(OriginPolicy.isExternalHttps("https://user@github.com/"));
    }
    @Test public void configuredNonDefaultPortIsRespected() {
        OriginPolicy custom = new OriginPolicy("https://school.example:8443/");
        assertTrue(custom.isTrusted("https://school.example:8443/lesson/"));
        assertFalse(custom.isTrusted("https://school.example/"));
    }
    @Test(expected=IllegalArgumentException.class) public void rejectsInsecureHome() {
        new OriginPolicy("http://school.example/");
    }
}
