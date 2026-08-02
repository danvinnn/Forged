using System.Text.Json;
using OriginalCircuit.Altium;
using OriginalCircuit.Altium.Models.Pcb;
using OriginalCircuit.Altium.Models.Sch;
using OriginalCircuit.Eda.Primitives;
// Concrete types carry more than the interfaces expose, so the readers hand back
// the interface and we cast down to see everything Altium stored.

// Second oracle for the Forge Altium generator.
//
// pyaltiumlib is the first. It stops at schematic record 44, so it cannot see a
// footprint link at all, and a test that asserts "the reader logged nothing"
// would have gone quiet exactly where new code lives. AltiumSharp reads the
// records pyaltiumlib does not, and it round-trips a large corpus of real
// Altium files, which makes it the closest independent check to Altium itself.
//
// Modes:
//   <file>                 read and print what was recovered
//   --roundtrip <file>     read, write back out, read again, and compare
//   --write-probe <dir>    have AltiumSharp write libraries from scratch, so its
//                          choices can be diffed against ours
//
// Prints JSON on stdout. Any exception is a failure to read the library.

var options = new JsonSerializerOptions { WriteIndented = false };

try
{
    if (args.Length == 2 && args[0] == "--roundtrip")
        return Emit(await RoundTrip(args[1]), options);

    if (args.Length == 2 && args[0] == "--write-probe")
        return Emit(await WriteProbe(args[1]), options);

    if (args.Length != 1 || args[0].StartsWith("--"))
    {
        Console.WriteLine("""{"error":"usage: altium-oracle [--roundtrip|--write-probe] <path>"}""");
        return 2;
    }

    var read = await Read(args[0]);
    if (read is null)
    {
        Console.WriteLine(JsonSerializer.Serialize(new { error = $"unsupported extension {Path.GetExtension(args[0])}" }, options));
        return 2;
    }

    return Emit(read, options);
}
catch (Exception error)
{
    Console.WriteLine(JsonSerializer.Serialize(new { error = $"{error.GetType().Name}: {error.Message}", detail = error.ToString() }, options));
    return 1;
}

static int Emit(object result, JsonSerializerOptions options)
{
    Console.WriteLine(JsonSerializer.Serialize(result, options));
    return 0;
}

// Reads a library and projects it down to the geometry and identity we care about.
// The projection is the comparison unit for --roundtrip: two reads that project
// the same have preserved everything this oracle can see.
static async Task<object> Read(string path)
{
    var extension = Path.GetExtension(path).ToLowerInvariant();

    if (extension == ".pcblib")
    {
        var library = (PcbLibrary)await AltiumLibrary.OpenPcbLibAsync(path);
        return new
        {
            reader = "AltiumSharp",
            libType = "PCB",
            componentCount = library.Components.Count,
            parts = library.Components.Cast<PcbComponent>().Select(c => new
            {
                name = c.Name,
                description = c.Description,
                padCount = c.Pads.Count,
                trackCount = c.Tracks.Count,
                arcCount = c.Arcs.Count,
                textCount = c.Texts.Count,
                bodyCount = c.ComponentBodies.Count,
                pads = c.Pads.Cast<PcbPad>().Select(p => new
                {
                    designator = p.Designator,
                    layer = p.Layer,
                    x = p.Location.X.ToMils(),
                    y = p.Location.Y.ToMils(),
                    sizeX = p.SizeTop.X.ToMils(),
                    sizeY = p.SizeTop.Y.ToMils(),
                    holeSize = p.HoleSize.ToMils(),
                    shapeTop = (int)p.ShapeTop,
                    rotation = p.Rotation
                }).ToList(),
                tracks = c.Tracks.Cast<PcbTrack>().Select(t => new
                {
                    layer = t.Layer,
                    x1 = t.Start.X.ToMils(),
                    y1 = t.Start.Y.ToMils(),
                    x2 = t.End.X.ToMils(),
                    y2 = t.End.Y.ToMils(),
                    width = t.Width.ToMils()
                }).ToList(),
                arcs = c.Arcs.Cast<PcbArc>().Select(a => new
                {
                    layer = a.Layer,
                    x = a.Center.X.ToMils(),
                    y = a.Center.Y.ToMils(),
                    radius = a.Radius.ToMils(),
                    startAngle = a.StartAngle,
                    endAngle = a.EndAngle,
                    width = a.Width.ToMils()
                }).ToList(),
                texts = c.Texts.Cast<PcbText>().Select(t => new { layer = t.Layer, text = t.Text }).ToList(),
                bodies = c.ComponentBodies.Cast<PcbComponentBody>().Select(b => new
                {
                    modelId = b.ModelId,
                    modelName = b.ModelName,
                    embed = b.ModelEmbed,
                    layer = b.Layer,
                    layerName = b.LayerName,
                    overallHeight = b.OverallHeight.ToMils()
                }).ToList()
            }).ToList(),
            models = library.Models.Select(m => new
            {
                id = m.Id,
                name = m.Name,
                embedded = m.IsEmbedded,
                checksum = m.Checksum,
                stepBytes = m.StepData?.Length ?? 0
            }).ToList()
        };
    }

    if (extension == ".schlib")
    {
        var library = (SchLibrary)await AltiumLibrary.OpenSchLibAsync(path);
        return new
        {
            reader = "AltiumSharp",
            libType = "Schematic",
            componentCount = library.Components.Count,
            parts = library.Components.Cast<SchComponent>().Select(c => new
            {
                name = c.LibReference,
                description = c.Description,
                pinCount = c.Pins.Count,
                pins = c.Pins.Cast<SchPin>().Select(p => new
                {
                    designator = p.Designator,
                    name = p.Name,
                    x = p.Location.X.ToMils(),
                    y = p.Location.Y.ToMils(),
                    length = p.Length.ToMils(),
                    electricalType = (int)p.ElectricalType
                }).ToList(),
                implementations = c.Implementations.Cast<SchImplementation>().Select(i => new
                {
                    modelName = i.ModelName,
                    modelType = i.ModelType,
                    isCurrent = i.IsCurrent,
                    dataFileCount = i.DataFileKinds.Count
                }).ToList()
            }).ToList()
        };
    }

    return null;
}

// Read our file, write it back out through AltiumSharp, read the result, compare.
//
// Reading alone proves a reader could make sense of the bytes. This proves the
// meaning survives a full trip through an independent implementation, which is a
// harder thing to pass accidentally: a field we wrote in a place the reader
// tolerates but does not understand comes back missing on the second read.
//
// The rewritten file is not expected to be byte-identical to ours. AltiumSharp
// makes its own choices about ordering and about the streams it emits, so the
// byte count is reported as information, and the projection equality is the
// assertion.
static async Task<object> RoundTrip(string path)
{
    var before = await Read(path) ?? throw new InvalidOperationException($"unsupported extension {Path.GetExtension(path)}");

    var rewritten = Path.Combine(Path.GetTempPath(), $"forge-roundtrip-{Guid.NewGuid():N}{Path.GetExtension(path)}");
    try
    {
        var extension = Path.GetExtension(path).ToLowerInvariant();
        if (extension == ".pcblib")
            await ((PcbLibrary)await AltiumLibrary.OpenPcbLibAsync(path)).SaveAsync(rewritten);
        else
            await ((SchLibrary)await AltiumLibrary.OpenSchLibAsync(path)).SaveAsync(rewritten);

        var after = await Read(rewritten);

        var options = new JsonSerializerOptions { WriteIndented = false };
        var beforeJson = JsonSerializer.Serialize(before, options);
        var afterJson = JsonSerializer.Serialize(after, options);

        return new
        {
            mode = "roundtrip",
            identical = beforeJson == afterJson,
            originalBytes = new FileInfo(path).Length,
            rewrittenBytes = new FileInfo(rewritten).Length,
            // Reported, never asserted. Compound files carry timestamps, sector
            // ordering and a container-level marker stream that differ without
            // any of the content differing.
            byteIdentical = await File.ReadAllBytesAsync(path) is var originalBytes
                && await File.ReadAllBytesAsync(rewritten) is var rewrittenBytes
                && originalBytes.AsSpan().SequenceEqual(rewrittenBytes),
            before,
            after
        };
    }
    finally
    {
        if (File.Exists(rewritten)) File.Delete(rewritten);
    }
}

// Has AltiumSharp write libraries from scratch, so its idea of a from-nothing
// library can be diffed against ours.
//
// The PcbLib carries one primitive on each mechanical layer we use, which is the
// point: the layer id we write for Mechanical 15 was derived rather than observed,
// and this makes an independent implementation commit to a byte for the same name.
static async Task<object> WriteProbe(string directory)
{
    Directory.CreateDirectory(directory);

    var pcbPath = Path.Combine(directory, "PROBE.PcbLib");
    var pcb = new PcbLibrary();
    var footprint = new PcbComponent { Name = "PROBE", Description = "AltiumSharp write probe" };

    // Bodies are named by layer, not numbered: the writer resolves the name to a
    // byte on its own, and the reader recovers that byte from the record without
    // consulting the name. So the pair that comes back out is an independent
    // implementation's answer to "which byte is Mechanical 15", not ours.
    var probedLayers = new[] { "MECHANICAL1", "MECHANICAL13", "MECHANICAL15", "MECHANICAL16" };
    foreach (var layerName in probedLayers)
    {
        var body = new PcbComponentBody { LayerName = layerName, Name = layerName, OverallHeight = Coord.FromMils(10) };
        body.SetOutline(new[]
        {
            new CoordPoint(Coord.FromMils(-50), Coord.FromMils(-50)),
            new CoordPoint(Coord.FromMils(50), Coord.FromMils(-50)),
            new CoordPoint(Coord.FromMils(50), Coord.FromMils(50)),
            new CoordPoint(Coord.FromMils(-50), Coord.FromMils(50))
        });
        footprint.AddComponentBody(body);
    }

    // One track per layer we actually emit to, so the file also carries the
    // numeric form of the same claim.
    foreach (var (layer, y) in new[] { (1, 0.0), (33, 20.0), (71, 40.0) })
    {
        footprint.AddTrack(new PcbTrack
        {
            Layer = layer,
            Start = new CoordPoint(Coord.FromMils(-100), Coord.FromMils(y)),
            End = new CoordPoint(Coord.FromMils(100), Coord.FromMils(y)),
            Width = Coord.FromMils(5)
        });
    }

    pcb.Add(footprint);
    await pcb.SaveAsync(pcbPath);

    return new
    {
        mode = "write-probe",
        pcbLib = pcbPath,
        probedLayers,
        readBack = await Read(pcbPath)
    };
}
