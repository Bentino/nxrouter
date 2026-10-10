"""Inspect the actual release archive; no extraction or execution."""
import hashlib
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

archive = Path(sys.argv[1])
with zipfile.ZipFile(archive) as z:
    names = z.namelist()
    required = ['package.json', 'out/extension.js', 'out/runtime/nxRuntime.js', 'out/runtime/openaiProvider.js',
                'out/runtime/openaiAuth.js', 'out/runtime/references.js', 'out/runtime/contextSources.js',
                'out/sidebar/sessionStore.js', 'out/sidebar/providerState.js', 'out/sidebar/providerPicker.js',
                'out/worker/productionTools.js', 'media/sidebar.js', 'media/sidebar.css', 'media/markdown.js', 'media/nx-router.svg']
    for name in required:
        assert 'extension/' + name in names, f'Missing production module: {name}'
    forbidden = re.compile(r'(^|/)(node_modules|src|scripts|test|tests|benchmarks|\.test-results|\.github|\.git|\.codex|\.agents|\.aws|evidence)(/|$)|\.(map|log|vsix)$|(^|/)(\.env[^/]*|auth\.json|credentials[^/]*|.*probe[^/]*|.*transcript[^/]*)$', re.I)
    assert not [name for name in names if forbidden.search(name)], 'Unexpected development/private artifact'
    for module in ['acceptance', 'provider', 'tool']:
        assert f'extension/out/{module}.js' not in names, 'Fixture-only implementation packaged'
    manifest = json.loads(z.read('extension/package.json'))
    identity = ET.fromstring(z.read('extension.vsixmanifest')).find('.//{*}Identity')
    assert identity is not None and identity.attrib['Version'] == manifest['version'], 'VSIX/extension version mismatch'
    assert identity.attrib['Id'] == manifest['name'] and identity.attrib['Publisher'] == manifest['publisher'], 'VSIX/extension identity mismatch'
    contributions = manifest['contributes']
    assert not contributions.get('languageModelChatProviders')
    serialized = json.dumps(contributions)
    assert not re.search(r'nx-spike|nx_spike|boundary-fixture|acceptance fixture|NX Native Spike|fixtureModels|nxRouter\.models\.', serialized, re.I)
    assert len(contributions['commands']) == 10
    activation = z.read('extension/out/extension.js').decode()
    assert "registerTextDocumentContentProvider('nx-router-diff'" in activation
    assert activation.index("registerTextDocumentContentProvider('nx-router-diff'") < activation.index('if (fixturesRegistered)')
    assert "process.env.NX_ROUTER_FIXTURES === '1'" in activation
    assert 'languageModelChatProviders' in activation
    # Fixture implementations must be loaded only inside the manifest+environment gate.
    for module in ['acceptance', 'tool']:
        positions = [m.start() for m in re.finditer(r'require\([\'\"]\./' + module + r'[\'\"]\)', activation)]
        assert positions and all(position > activation.index('if (fixturesRegistered)') for position in positions)
    result = {'status': 'passed', 'version': manifest['version'], 'vsixMetadataVersion': identity.attrib['Version'], 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
              'archiveEntries': len(names), 'requiredModules': required, 'sourceMaps': False, 'fixtureImplementations': False,
              'fixtureContributions': False, 'testsProbesEvidenceBenchmarks': False, 'nativeDiffProductionRegistration': True}
    print(json.dumps(result, indent=2))
