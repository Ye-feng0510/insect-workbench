"""识别服务测试:分类校验逻辑(不依赖真实模型)。"""
import asyncio

import pytest

from app.services import recognition_service
from app.services.recognition_service import validate_taxonomy, validate_confirmed_fields
from app.field_mapping import TAXONOMY_FIELDS


class TestTaxonomyValidation:
    """清单第 11 节的分类字段校验。"""

    def test_valid_taxonomy(self):
        """清单第 13 节示例数据应通过校验。"""
        taxonomy = {
            "Phylum": "Arthropoda",
            "纲": "昆虫纲",
            "Class": "Insecta",
            "Order": "Hemiptera",
            "中文科名": "红蝽科",
            "科名": "Pyrrhocoridae",
            "属名": "Dysdercus",
            "种名": "cingulatus",
        }
        errors = validate_taxonomy(taxonomy)
        assert errors == []

    def test_missing_fields(self):
        """缺少字段时报错。"""
        taxonomy = {
            "Phylum": "Arthropoda",
            "纲": "昆虫纲",
            "Class": "Insecta",
            "Order": "Hemiptera",
            "中文科名": "红蝽科",
            "科名": "Pyrrhocoridae",
            "属名": "Dysdercus",
            # 种名缺失
        }
        errors = validate_taxonomy(taxonomy)
        assert any("种名" in e for e in errors)

    def test_chinese_in_latin_field(self):
        """拉丁文字段含中文报错。"""
        taxonomy = {
            "Phylum": "节肢动物门",  # 错误:应为拉丁文
            "纲": "昆虫纲",
            "Class": "Insecta",
            "Order": "Hemiptera",
            "中文科名": "红蝽科",
            "科名": "Pyrrhocoridae",
            "属名": "Dysdercus",
            "种名": "cingulatus",
        }
        errors = validate_taxonomy(taxonomy)
        assert any("Phylum" in e for e in errors)

    def test_latin_in_chinese_field(self):
        """中文字段不含中文报错。"""
        taxonomy = {
            "Phylum": "Arthropoda",
            "纲": "Insecta",  # 错误:应含中文
            "Class": "Insecta",
            "Order": "Hemiptera",
            "中文科名": "红蝽科",
            "科名": "Pyrrhocoridae",
            "属名": "Dysdercus",
            "种名": "cingulatus",
        }
        errors = validate_taxonomy(taxonomy)
        assert any("纲" in e for e in errors)

    def test_shu_lowercase(self):
        """属名首字母必须大写。"""
        taxonomy = {
            "Phylum": "Arthropoda",
            "纲": "昆虫纲",
            "Class": "Insecta",
            "Order": "Hemiptera",
            "中文科名": "红蝽科",
            "科名": "Pyrrhocoridae",
            "属名": "dysdercus",  # 错误:首字母小写
            "种名": "cingulatus",
        }
        errors = validate_taxonomy(taxonomy)
        assert any("属名" in e and "大写" in e for e in errors)

    def test_zhong_uppercase(self):
        """种名首字母必须小写。"""
        taxonomy = {
            "Phylum": "Arthropoda",
            "纲": "昆虫纲",
            "Class": "Insecta",
            "Order": "Hemiptera",
            "中文科名": "红蝽科",
            "科名": "Pyrrhocoridae",
            "属名": "Dysdercus",
            "种名": "Cingulatus",  # 错误:首字母大写
        }
        errors = validate_taxonomy(taxonomy)
        assert any("种名" in e and "小写" in e for e in errors)

    def test_zhong_full_binomial(self):
        """种名不能是完整双名(含空格)。"""
        taxonomy = {
            "Phylum": "Arthropoda",
            "纲": "昆虫纲",
            "Class": "Insecta",
            "Order": "Hemiptera",
            "中文科名": "红蝽科",
            "科名": "Pyrrhocoridae",
            "属名": "Dysdercus",
            "种名": "Dysdercus cingulatus",  # 错误:完整双名
        }
        errors = validate_taxonomy(taxonomy)
        assert any("种名" in e and "种加词" in e for e in errors)


class TestConfirmedFieldsValidation:
    """清单要求的确认字段校验。"""

    def test_valid_confirmed(self):
        """完整的5项确认应通过。"""
        confirmed = {
            "中名": "二点红蝽",
            "产地3": "龙岗园山景区",
            "图像": "PSZP-00842",
            "采集人": "",
            "采集日期": "2009-10-24",
        }
        warnings = validate_confirmed_fields(confirmed)
        assert warnings == []

    def test_missing_zhongming_raises(self):
        """中名为空时报错。"""
        with pytest.raises(Exception) as exc_info:
            validate_confirmed_fields({
                "中名": "",
                "图像": "PSZP-001",
            })
        assert "中名" in str(exc_info.value.detail)

    def test_missing_tuxiang_raises(self):
        """图像编号为空时报错。"""
        with pytest.raises(Exception) as exc_info:
            validate_confirmed_fields({
                "中名": "二点红蝽",
                "图像": "",
            })
        assert "图像" in str(exc_info.value.detail)

    def test_missing_chandi_warns(self):
        """产地3为空时警告但允许继续。"""
        warnings = validate_confirmed_fields({
            "中名": "二点红蝽",
            "图像": "PSZP-001",
            "产地3": "",
            "采集日期": "2009-10-24",
        })
        assert any("产地3" in w for w in warnings)

    def test_missing_caiji_riqi_warns(self):
        """采集日期为空时警告但允许继续。"""
        warnings = validate_confirmed_fields({
            "中名": "二点红蝽",
            "图像": "PSZP-001",
            "产地3": "龙岗园山景区",
            "采集日期": "",
        })
        assert any("采集日期" in w for w in warnings)

    def test_empty_caijiren_ok(self):
        """采集人为空时不警告。"""
        warnings = validate_confirmed_fields({
            "中名": "二点红蝽",
            "图像": "PSZP-001",
            "产地3": "龙岗园山景区",
            "采集日期": "2009-10-24",
            "采集人": "",
        })
        assert not any("采集人" in w for w in warnings)

    def test_empty_jiandingren_ok(self):
        warnings = validate_confirmed_fields({
            "中名": "二点红蝽",
            "图像": "PSZP-001",
            "产地3": "龙岗园山景区",
            "采集日期": "2009-10-24",
            "鉴定人": "",
        })
        assert not any("鉴定人" in w for w in warnings)

    def test_invalid_date_raises(self):
        with pytest.raises(Exception) as exc_info:
            validate_confirmed_fields({
                "中名": "二点红蝽",
                "图像": "PSZP-001",
                "产地3": "龙岗园山景区",
                "采集日期": "2009-02-30",
            })
        assert "YYYY-MM-DD" in str(exc_info.value.detail)

    def test_jiandingren_length_is_limited(self):
        with pytest.raises(Exception) as exc_info:
            validate_confirmed_fields({
                "中名": "二点红蝽",
                "图像": "PSZP-001",
                "产地3": "龙岗园山景区",
                "采集日期": "2009-10-24",
                "鉴定人": "甲" * 201,
            })
        assert "200" in str(exc_info.value.detail)


def test_recognition_uses_filtered_ocr_evidence(monkeypatch):
    ocr_result = {
        "lines": [
            {"text": "PSZP-001", "confidence": 0.99, "box": []},
            {"text": "噪声", "confidence": 0.1, "box": []},
        ],
        "warnings": [],
    }
    monkeypatch.setattr(
        recognition_service.ocr_service,
        "recognize_text",
        lambda *_args: ocr_result,
    )

    class Client:
        async def recognize_image(self, *_args, **kwargs):
            assert kwargs["ocr_result"]["lines"] == [ocr_result["lines"][0]]
            return {"中名": "二点红蝽"}

    result = asyncio.run(
        recognition_service.recognize_image_with_ocr(
            Client(), "unused.jpg", "prompt"
        )
    )

    assert result["中名"] == "二点红蝽"
    assert result["_ocr"]["lines"] == [ocr_result["lines"][0]]
