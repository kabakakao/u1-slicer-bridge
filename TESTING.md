# Testing Guide

## Quick Test

1. **Download a test file** from MakerWorld:
   - [Simple Cube](https://makerworld.com/en/models/1204272-a-simple-cube-test-print)
   - [Test Cube with Labels](https://makerworld.com/en/models/705572-test-cube)
   - [Calibration Cube V3](https://makerworld.com/en/models/417128-simple-calibration-cube-v3)

2. **Run the test script**:
   ```bash
   ./test_workflow.sh ~/Downloads/test_cube.3mf
   ```

That's it! The script will test the full workflow automatically.

## What Gets Tested

The test script validates the complete workflow:

```
Upload 3MF → Validate Plate → Slice → G-code
```

### API Endpoints Tested
- ✓ `POST /upload` - Upload 3MF file (validates plate bounds)
- ✓ `GET /upload` - List uploads
- ✓ `GET /upload/{id}` - Retrieve upload details
- ✓ `GET /filaments` - List available filaments
- ✓ `POST /uploads/{id}/slice` - Slice upload with settings
- ✓ `GET /jobs/{job_id}` - Check slicing job status
- ✓ `GET /jobs/{job_id}/download` - Download G-code
- ✓ `GET /jobs/{job_id}/gcode/metadata` - Viewer metadata
- ✓ `GET /jobs/{job_id}/gcode/layers` - Layer geometry

### Validation Steps
1. **Health Check** - API responding
2. **Upload** - 3MF file parsed, plate bounds validated (270x270x270mm)
3. **Filament Selection** - Choose PLA/PETG/ABS/TPU profile
4. **Slicing** - Snapmaker OrcaSlicer generates G-code
5. **Metadata Extraction** - Print time, filament usage, layer count
6. **G-code Validation** - File exists and contains expected headers
7. **Viewer Data** - Layer geometry extracted for preview

## Manual Testing

If you prefer to test manually with `curl`:

### 1. Upload 3MF
```bash
curl -X POST http://localhost:8000/upload \
  -F "file=@test.3mf" \
  | jq
```

**Expected output:**
```json
{
  "upload_id": 1,
  "filename": "test.3mf",
  "file_size": 123456,
  "objects": [
    {
      "name": "cube",
      "object_id": "1",
      "vertices": 8,
      "triangles": 12
    }
  ]
}
```

### 2. List Filaments
```bash
curl http://localhost:8000/filaments | jq
```

**Expected output:**
```json
{
  "filaments": [
    {
      "id": 1,
      "name": "Snapmaker Generic PLA",
      "material": "PLA",
      "nozzle_temp": 210,
      "bed_temp": 60,
      "print_speed": 60,
      "is_default": true
    }
  ]
}
```

### 3. Slice Upload
```bash
# Use upload_id from step 1
curl -X POST http://localhost:8000/uploads/1/slice \
  -H "Content-Type: application/json" \
  -d '{
    "filament_id": 1,
    "layer_height": 0.2,
    "infill_density": 15,
    "supports": false
  }' \
  | jq
```

**Expected output:**
```json
{
  "job_id": "slice_abc123",
  "upload_id": 1,
  "status": "completed",
  "gcode_path": "/data/slices/slice_abc123.gcode",
  "gcode_size_mb": 18.5,
  "metadata": {
    "estimated_time_seconds": 28800,
    "filament_used_mm": 29900,
    "layer_count": 158
  }
}
```

### 4. Download G-code
```bash
curl -o output.gcode http://localhost:8000/jobs/slice_abc123/download
```

### 5. Get Viewer Metadata
```bash
curl http://localhost:8000/jobs/slice_abc123/gcode/metadata | jq
```

### 6. Get Layer Data
```bash
curl http://localhost:8000/jobs/slice_abc123/gcode/layers?start=0&count=10 | jq
```

## Viewing Logs

Check slicing logs:
```bash
docker exec u1-slicer-bridge-api-1 tail -f /data/logs/slice_xyz123.log
```

Check G-code output:
```bash
docker exec u1-slicer-bridge-api-1 head -n 50 /data/slices/slice_xyz123.gcode
```

## Troubleshooting

### Upload fails with "No valid objects found"
- File is not a valid 3MF
- 3MF contains no meshes
- Check logs: `docker logs u1-slicer-bridge-api-1`

### Upload shows bounds warning
- Plate exceeds Snapmaker U1 build volume (270x270x270mm)
- Warning returned in upload response
- You can still attempt to slice (may fail)

### Slicing fails
- Plate exceeds build volume
- Snapmaker OrcaSlicer error (check job logs)
- Invalid filament_id or settings

### Check Docker containers
```bash
docker ps  # All containers should be "Up"
docker logs u1-slicer-bridge-api-1  # API logs
```

### Verify Snapmaker OrcaSlicer installation
```bash
docker exec u1-slicer-bridge-api-1 xvfb-run -a orca-slicer --version
```

**Expected output:**
```
OrcaSlicer 2.2.4
```

## Expected Results

After a successful test run, you should have:
1. ✅ Upload record in database with plate bounds
2. ✅ 3MF file stored in `/data/uploads/`
3. ✅ Slicing job record with status
4. ✅ Valid G-code file in `/data/slices/`
5. ✅ G-code metadata (time, filament, layers)
6. ✅ Job log in `/data/logs/`

## Performance Benchmarks

Typical timing for a simple cube:
- Upload + validation: < 1 second
- Slicing: 30-60 seconds (depends on complexity)
- Viewer metadata extraction: 1-2 seconds

## Next Steps After Testing

Current status:
1. ✅ Web UI complete (M7) - 3-step workflow at http://localhost:8080
2. ✅ G-code preview complete - Interactive 2D layer viewer
3. ⚠️ Moonraker integration partial (M2) - Health check only
4. ❌ Print control not implemented (M8) - No upload/start print endpoints

Next steps:
1. Implement M8 print control (upload G-code to printer, start/stop/pause)
2. Add WebSocket for real-time job updates (optional)
3. Add print queue management (optional)
